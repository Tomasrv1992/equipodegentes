// Tests de CARACTERIZACIÓN de pipeline.ts.
//
// Objetivo: congelar el comportamiento ACTUAL de las funciones puras/aislables
// como red de seguridad antes de un futuro refactor (split de pipeline.ts).
// Documentan lo que el código HACE hoy, no lo que debería hacer. Fixtures 100%
// sintéticos (NITs/CUFEs inventados, XML DIAN mínimo). Cero datos reales.
//
// Funciones internas expuestas con `export` para poder testearlas (cambio
// inocuo, sin tocar su lógica): isDuplicate, normalizeProveedorName,
// isSelfEmitted, buildFileBaseName, asNumber, asString, parseInvoiceXml.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  mapMotivoToLabel,
  normalizeProveedorName,
  isDuplicate,
  nitMatch,
  isSelfEmitted,
  buildFileBaseName,
  asNumber,
  asString,
  parseInvoiceXml,
} from "../pipeline";

// ===== mapMotivoToLabel =====
describe("mapMotivoToLabel", () => {
  it("motivos de duplicado -> Duplicado/<year>; el resto -> Descartado/<year>", () => {
    expect(mapMotivoToLabel("dup-en-sheet", 2026)).toBe("Duplicado/2026");
    expect(mapMotivoToLabel("dup-constraint-bd", 2026)).toBe("Duplicado/2026");
    expect(mapMotivoToLabel("cualquier-cosa", 2025)).toBe("Descartado/2025");
    expect(mapMotivoToLabel("planilla-ss-tercero", 2026)).toBe("Descartado/2026");
  });
});

// ===== normalizeProveedorName =====
describe("normalizeProveedorName", () => {
  it("string vacio o null -> ''", () => {
    expect(normalizeProveedorName("")).toBe("");
    expect(normalizeProveedorName(undefined as unknown as string)).toBe("");
  });
  it("quita sufijo S.A.S y baja a minusculas", () => {
    expect(normalizeProveedorName("DENTILANDIA S.A.S")).toBe("dentilandia");
    expect(normalizeProveedorName("Dentilandia SAS")).toBe("dentilandia");
  });
  it("quita acentos", () => {
    expect(normalizeProveedorName("Tomás Ramírez Villa")).toBe("tomas ramirez villa");
  });
  it("quita Ltda y colapsa espacios/puntuacion", () => {
    expect(normalizeProveedorName("Comercial  Ltda.")).toBe("comercial");
  });
});

// ===== isDuplicate (esquema sin col "#": 0=Fecha, 1=proveedor, 2=nit, 3=numero) =====
describe("isDuplicate", () => {
  const row = (proveedor: string, nit: string, numero: string) => ["", proveedor, nit, numero];

  it("numero vacio -> false (no se puede deduplicar)", () => {
    expect(isDuplicate([row("Prov", "900", "FE1")], "", "900", "Prov")).toBe(false);
  });
  it("mismo numero + mismo NIT -> true", () => {
    expect(isDuplicate([row("Prov", "900123456", "FE1")], "FE1", "900123456", "Prov")).toBe(true);
  });
  it("mismo numero pero NIT distinto -> false", () => {
    expect(isDuplicate([row("Prov", "900123456", "FE1")], "FE1", "111111111", "Prov")).toBe(false);
  });
  it("mismo numero, sin NIT en ninguno, mismo proveedor -> true", () => {
    expect(isDuplicate([row("Comercial SAS", "", "FE1")], "FE1", "", "Comercial S.A.S")).toBe(true);
  });
  it("mismo numero, sin NIT, proveedor distinto -> false", () => {
    expect(isDuplicate([row("Comercial SAS", "", "FE1")], "FE1", "", "Otra Empresa")).toBe(false);
  });
  it("numero no presente en las filas -> false", () => {
    expect(isDuplicate([row("Prov", "900", "FE1")], "FE2", "900", "Prov")).toBe(false);
  });
  it("mismo numero, sin NIT ni proveedor -> true (conservador)", () => {
    expect(isDuplicate([row("", "", "FE1")], "FE1", "", undefined)).toBe(true);
  });

  // --- Regresiones 2026-06-19: re-duplicación al reprocesar ---
  it("ceros a la izquierda: '05' vs '5' (Sheets colapsa RAW) + mismo NIT -> true", () => {
    // La fila guardada tiene '5' (Sheets convirtió '05'->5); el doc re-extraído trae '05'.
    expect(isDuplicate([row("Araque", "1152466510", "5")], "05", "1152466510", "Araque")).toBe(true);
    expect(isDuplicate([row("Prov", "900", "0029")], "29", "900", "Prov")).toBe(true);
  });
  it("ceros a la izquierda pero NIT distinto -> false (no colapsar entre proveedores)", () => {
    // Tres CC distintas con numero '5' (Stefania/Tatiana/Araque) NO deben deduparse.
    expect(isDuplicate([row("Stefania", "1152201138", "5")], "5", "1152188032", "Tatiana")).toBe(false);
  });
  it("NIT con dígito de verificación: '1040182652' vs '10401826529' + mismo numero -> true", () => {
    expect(isDuplicate([row("Lab", "10401826529", "7654")], "7654", "1040182652", "Lab")).toBe(true);
    expect(isDuplicate([row("Lab", "1040182652", "7671")], "7671", "10401826529", "Lab")).toBe(true);
  });

  // --- Dedup por CONTENIDO para CC sin numero (numero no-informativo) ---
  // Fila completa A:M con total en col J (idx 9).
  const rowFull = (prov: string, nit: string, numero: string, total: number) =>
    ["46170", prov, nit, numero, 0, 0, 0, 0, 0, total, "", "", ""];

  it("CC sin numero: misma entidad + mismo total = dup aunque el numero difiera", () => {
    // Caso real Catalina: fila guardada con numero "46143" (fecha mal extraída);
    // el reproceso trae "Sin número" → debe detectarse dup por contenido.
    const rows = [rowFull("CATALINA MANES URIBE", "1152459140", "46143", 2970160)];
    expect(isDuplicate(rows, "Sin número", "1152459140", "CATALINA MANES URIBE", 2970160)).toBe(true);
    // Caso real Juan David: "sin número de consecutivo" vs "no especificado".
    const rows2 = [rowFull("JUAN DAVID MOLINA", "10014693950", "sin número de consecutivo", 225000)];
    expect(isDuplicate(rows2, "no especificado", "10014693950", "JUAN DAVID MOLINA", 225000)).toBe(true);
  });
  it("CC sin numero pero distinto total -> NO dup", () => {
    const rows = [rowFull("CATALINA", "1152459140", "46143", 2970160)];
    expect(isDuplicate(rows, "Sin número", "1152459140", "CATALINA", 999999)).toBe(false);
  });
  it("dos facturas INFORMATIVAS mismo total distinto numero -> NO dup (no aplica contenido)", () => {
    // Salvaguarda: el dedup por contenido NO debe colapsar 2 facturas reales con
    // numero válido distinto aunque coincida el total.
    const rows = [rowFull("Lab", "900", "FE100", 50000)];
    expect(isDuplicate(rows, "FE200", "900", "Lab", 50000)).toBe(false);
  });
});

// ===== nitMatch (tolerancia al dígito de verificación) =====
describe("nitMatch", () => {
  it("igualdad exacta -> true", () => {
    expect(nitMatch("900123456", "900123456")).toBe(true);
  });
  it("base vs base+DV (1 dígito extra al final) -> true", () => {
    expect(nitMatch("1040182652", "10401826529")).toBe(true);
    expect(nitMatch("10401826529", "1040182652")).toBe(true);
    expect(nitMatch("901087252", "9010872521")).toBe(true);
  });
  it("difieren en >1 dígito o en el medio -> false", () => {
    expect(nitMatch("900123456", "111111111")).toBe(false);
    expect(nitMatch("1040182652", "1040182653")).toBe(false); // misma longitud, último dígito distinto
    expect(nitMatch("1040182652", "104018265299")).toBe(false); // 2 dígitos extra
  });
  it("alguno vacío -> false", () => {
    expect(nitMatch("", "900123456")).toBe(false);
    expect(nitMatch("900123456", "")).toBe(false);
  });
  it("ignora formato (puntos/guiones) -> compara solo dígitos", () => {
    expect(nitMatch("900.123.456", "900123456")).toBe(true);
    expect(nitMatch("900.123.456-7", "900123456")).toBe(true); // base + DV con guión
  });
});

// ===== isSelfEmitted =====
describe("isSelfEmitted", () => {
  it("NIT extraido === nitCliente -> true (con o sin DV/formato)", () => {
    expect(isSelfEmitted("Cualquiera", "900.123.456", "900123456", null)).toBe(true);
  });
  it("nombre del proveedor coincide con nombreClienteNorm -> true", () => {
    expect(isSelfEmitted("DENTILANDIA SAS", undefined, null, "dentilandia")).toBe(true);
  });
  it("nombreClienteNorm contenido en el proveedor -> true (includes)", () => {
    expect(isSelfEmitted("Dentilandia Sede Norte", undefined, null, "dentilandia")).toBe(true);
  });
  it("ni NIT ni nombre coinciden -> false", () => {
    expect(isSelfEmitted("Proveedor Externo", "111", "900123456", "dentilandia")).toBe(false);
  });
});

// ===== buildFileBaseName =====
describe("buildFileBaseName", () => {
  it("con numero: '{numero}. {Proveedor Title Case}'", () => {
    expect(buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", "FEL428843")).toBe(
      "FEL428843. Seguros De Vida Suramericana",
    );
  });
  it("sin numero: solo el proveedor en title case", () => {
    expect(buildFileBaseName(1, "sin proveedor", null)).toBe("Sin Proveedor");
  });
  it("con subIdx: '{numero}.{subIdx}. {Proveedor}'", () => {
    expect(buildFileBaseName(1, "Test", "FE1", 2)).toBe("FE1.2. Test");
  });
  it("sanitiza caracteres ilegales de filename en el numero", () => {
    expect(buildFileBaseName(1, "Prov", "FE/1:2")).toBe("FE-1-2. Prov");
  });
});

// ===== asNumber / asString (helpers de parseo XML) =====
describe("asNumber", () => {
  it("null/undefined -> 0", () => {
    expect(asNumber(null)).toBe(0);
    expect(asNumber(undefined)).toBe(0);
  });
  it("number pasa directo", () => {
    expect(asNumber(1234)).toBe(1234);
  });
  it("string numerica -> number", () => {
    expect(asNumber("100000")).toBe(100000);
  });
  it("objeto con #text -> parseFloat del #text", () => {
    expect(asNumber({ "#text": "50" })).toBe(50);
  });
  it("string no numerica -> 0", () => {
    expect(asNumber("no-es-numero")).toBe(0);
  });
});

describe("asString", () => {
  it("null -> ''", () => {
    expect(asString(null)).toBe("");
  });
  it("number -> string", () => {
    expect(asString(5)).toBe("5");
  });
  it("objeto con #text -> #text como string", () => {
    expect(asString({ "#text": "FE123" })).toBe("FE123");
  });
});

// ===== parseInvoiceXml (con fixture XML DIAN mínimo, sintético) =====
const PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

let tmpCounter = 0;
function writeTmpXml(content: string): string {
  const p = path.join(os.tmpdir(), `caract-pipeline-${process.pid}-${tmpCounter++}.xml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const facturaXml = (tipoDoc = "01", supplierNit = "900123456") => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <ID>FE12345</ID>
  <UUID>cufe-sintetico-abc-123</UUID>
  <IssueDate>2026-03-15</IssueDate>
  <InvoiceTypeCode>${tipoDoc}</InvoiceTypeCode>
  <AccountingSupplierParty>
    <Party>
      <PartyTaxScheme>
        <RegistrationName>Proveedor Test SAS</RegistrationName>
        <CompanyID>${supplierNit}</CompanyID>
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <LegalMonetaryTotal>
    <LineExtensionAmount>100000</LineExtensionAmount>
    <PayableAmount>119000</PayableAmount>
  </LegalMonetaryTotal>
  <TaxTotal>
    <TaxAmount>19000</TaxAmount>
    <TaxSubtotal>
      <TaxAmount>19000</TaxAmount>
      <TaxCategory>
        <TaxScheme>
          <ID>01</ID>
        </TaxScheme>
      </TaxCategory>
    </TaxSubtotal>
  </TaxTotal>
  <InvoiceLine>
    <Item>
      <Description>Servicio de prueba</Description>
    </Item>
  </InvoiceLine>
</Invoice>`;

describe("parseInvoiceXml", () => {
  it("factura DIAN tipo 01 -> extrae numero, cufe, proveedor, nit, montos, fecha, concepto", () => {
    const p = writeTmpXml(facturaXml("01"));
    const data = parseInvoiceXml(p, PARSER);
    expect(data).not.toBeNull();
    expect(data!.numero).toBe("FE12345");
    expect(data!.cufe).toBe("cufe-sintetico-abc-123");
    expect(data!.proveedor).toBe("Proveedor Test SAS");
    expect(data!.nit).toBe("900123456");
    expect(data!.fecha).toBe("2026-03-15");
    expect(data!.subtotal).toBe(100000);
    expect(data!.iva).toBe(19000);
    expect(data!.total).toBe(119000); // PayableAmount
    expect(data!.concepto).toBe("Servicio de prueba");
    expect(data!.totalRetenciones).toBe(0);
  });

  it("tipo de documento 91 (nota credito) -> null (no es factura de compra)", () => {
    const p = writeTmpXml(facturaXml("91"));
    expect(parseInvoiceXml(p, PARSER)).toBeNull();
  });

  it("supplier NIT === nitCliente -> null (auto-factura: el cliente es el emisor)", () => {
    const p = writeTmpXml(facturaXml("01", "901117356"));
    expect(parseInvoiceXml(p, PARSER, "901117356")).toBeNull();
  });
});
