// agentes/Equipo-facturacion/evals/run-evals.ts
//
// Harness de evaluación del extractor LLM (llm-extractor.ts). Carga los fixtures
// de fixtures/, llama al extractor REAL (sin duplicar lógica), compara campo por
// campo y reporta una tabla + resumen (precisión, falsos positivos/negativos).
//
// NO corre en CI (no es *.test.ts). Llama a la API de Anthropic (cuesta centavos).
//
// USO:
//   npx tsx --env-file=<archivo .env con ANTHROPIC_API_KEY> \
//     agentes/Equipo-facturacion/evals/run-evals.ts
//
// Cada fixture es una subcarpeta de fixtures/ con:
//   - input.txt     → el texto tal como lo recibe el LLM
//   - expected.json → { presumedType, nitCliente?, nombreCliente?, emailDate?,
//                       expected: { es_factura, numero_documento?, proveedor_nit?,
//                                   total?, fecha?, categoria? } }
//
// Nota: `categoria` es INFORMATIVA — el extractor LLM no categoriza (eso lo hace
// `categorizar()` en el pipeline, en un paso posterior). El harness la muestra
// pero no la evalúa.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractInvoiceFromText, type DocumentSource } from "../lib/llm-extractor";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures");

interface CasoConfig {
  presumedType: DocumentSource;
  nitCliente?: string;
  nombreCliente?: string;
  emailDate?: string;
  nota_caso?: string;
  expected: {
    es_factura: boolean;
    numero_documento?: string;
    proveedor_nit?: string;
    total?: number;
    fecha?: string;
    categoria?: string;
  };
}

const digits = (s: unknown) => String(s ?? "").replace(/\D+/g, "");

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ERROR: falta ANTHROPIC_API_KEY.\n" +
        "Correr con:  npx tsx --env-file=<.env con la key> agentes/Equipo-facturacion/evals/run-evals.ts",
    );
    process.exit(1);
  }

  const casos = fs
    .readdirSync(FIXTURES_DIR)
    .filter((d) => fs.statSync(path.join(FIXTURES_DIR, d)).isDirectory())
    .sort();

  let tp = 0, tn = 0, fp = 0, fn = 0;
  let camposOk = 0, camposTotal = 0;
  const filas: string[] = [];

  for (const caso of casos) {
    const dir = path.join(FIXTURES_DIR, caso);
    const text = fs.readFileSync(path.join(dir, "input.txt"), "utf8");
    const cfg: CasoConfig = JSON.parse(fs.readFileSync(path.join(dir, "expected.json"), "utf8"));
    const exp = cfg.expected;

    const result = await extractInvoiceFromText({
      text,
      presumedType: cfg.presumedType,
      nitCliente: cfg.nitCliente ?? null,
      nombreCliente: cfg.nombreCliente ?? null,
      emailDate: cfg.emailDate,
    });

    const obtEsFactura = result !== null;

    // Clasificación es_factura
    if (exp.es_factura && obtEsFactura) tp++;
    else if (!exp.es_factura && !obtEsFactura) tn++;
    else if (!exp.es_factura && obtEsFactura) fp++;
    else fn++;

    // Detalle por caso
    let estado: string;
    let detalle = "";
    if (exp.es_factura !== obtEsFactura) {
      estado = exp.es_factura ? "FAIL (falso negativo)" : "FAIL (falso positivo)";
    } else if (!exp.es_factura) {
      estado = "PASS (descartado OK)";
    } else {
      // Ambos factura: comparar campos
      const checks: Array<[string, boolean, string, string]> = [];
      if (exp.numero_documento !== undefined)
        checks.push(["numero", String(result!.numero).trim() === String(exp.numero_documento).trim(), exp.numero_documento, result!.numero]);
      if (exp.proveedor_nit !== undefined)
        checks.push(["nit", digits(result!.nit) === digits(exp.proveedor_nit), exp.proveedor_nit, result!.nit]);
      if (exp.total !== undefined)
        checks.push(["total", Number(result!.total) === Number(exp.total), String(exp.total), String(result!.total)]);
      if (exp.fecha !== undefined)
        checks.push(["fecha", String(result!.fecha) === String(exp.fecha), exp.fecha, result!.fecha]);

      const okN = checks.filter((c) => c[1]).length;
      camposOk += okN;
      camposTotal += checks.length;
      const fails = checks.filter((c) => !c[1]).map((c) => `${c[0]}(esp=${c[2]} obt=${c[3]})`);
      estado = fails.length === 0 ? "PASS" : `PARCIAL ${okN}/${checks.length}`;
      detalle = fails.join("  ");
    }

    filas.push(
      `${caso.padEnd(34)} | esp=${String(exp.es_factura).padEnd(5)} obt=${String(obtEsFactura).padEnd(5)} | ${estado}`,
    );
    if (detalle) filas.push(`${" ".repeat(34)} |   ${detalle}`);
    if (result && exp.categoria) filas.push(`${" ".repeat(34)} |   categoria (informativa, no evaluada): esperada=${exp.categoria}`);
  }

  const precision = tp + fp > 0 ? ((tp / (tp + fp)) * 100).toFixed(1) : "n/a";
  const recall = tp + fn > 0 ? ((tp / (tp + fn)) * 100).toFixed(1) : "n/a";

  console.log("\n===== EVALS EXTRACTOR LLM =====\n");
  console.log("Caso                               | es_factura          | estado");
  console.log("-".repeat(78));
  console.log(filas.join("\n"));
  console.log("\n----- RESUMEN -----");
  console.log(`Casos: ${casos.length}`);
  console.log(`Clasificación es_factura → TP=${tp} TN=${tn} FP=${fp} FN=${fn}`);
  console.log(`Precisión (TP/(TP+FP)): ${precision}%   ·   Recall (TP/(TP+FN)): ${recall}%`);
  console.log(`Falsos positivos (descartable extraído como factura): ${fp}`);
  console.log(`Falsos negativos (factura real descartada): ${fn}`);
  console.log(`Campos correctos en facturas bien clasificadas: ${camposOk}/${camposTotal}`);
}

main().catch((err) => {
  console.error("eval run failed:", err);
  process.exit(1);
});
