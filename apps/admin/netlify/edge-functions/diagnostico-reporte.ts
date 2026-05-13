// Edge function: /api/diagnostico-reporte
//
// Recibe { fecha }, consulta agent_runs del día, arma contexto, llama a Claude
// (Haiku 4.5) y devuelve un reporte ejecutivo en español pensado para Tomás.

import type { Context } from "@netlify/edge-functions";

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Validar JWT
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const anonKey = Netlify.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const allowedEmail = Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anonKey },
  });
  if (!userResp.ok) return new Response("invalid token", { status: 401 });
  const user = await userResp.json();
  if (user.email !== allowedEmail) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Calcular inicio del día Bogotá
  const now = new Date();
  const bogotaMs = now.getTime() - 5 * 60 * 60 * 1000;
  const startOfDay = new Date(bogotaMs);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const dayStartIso = new Date(startOfDay.getTime() + 5 * 60 * 60 * 1000).toISOString();

  // 3. Pull runs del día + clientes (service role)
  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const [runsResp, clientesResp] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/agent_runs?started_at=gte.${dayStartIso}&order=started_at.desc&select=*`,
      { headers: sbHeaders },
    ),
    fetch(`${supabaseUrl}/rest/v1/clientes?activo=eq.true&select=id,slug,nombre`, {
      headers: sbHeaders,
    }),
  ]);
  const runs = (await runsResp.json()) as any[];
  const clientes = (await clientesResp.json()) as Array<{ id: string; slug: string; nombre: string }>;
  const clienteById = new Map(clientes.map((c) => [c.id, c]));

  // 4. Armar contexto compacto para el LLM
  const synthetic = new Set(["monitor", "reparador", "limpiador", "supervisor", "owner"]);
  const clientesOp = clientes.filter((c) => !synthetic.has(c.slug));

  // Agregado por cliente (facturación)
  const porCliente: Record<string, { nombre: string; procesadas: number; saltadas: number; repetidas: number; errores: number; runs: number; status: string }> = {};
  let llmCostFact = 0;
  let llmCallsFact = 0;
  for (const r of runs) {
    if (r.agente_id !== "facturacion" || !r.cliente_id) continue;
    const c = clienteById.get(r.cliente_id);
    if (!c || synthetic.has(c.slug)) continue;
    const e = porCliente[c.slug] ?? {
      nombre: c.nombre,
      procesadas: 0,
      saltadas: 0,
      repetidas: 0,
      errores: 0,
      runs: 0,
      status: r.status,
    };
    const p = r.payload ?? {};
    e.procesadas += Number(p.procesadas ?? 0);
    e.saltadas += Number(p.saltadas ?? 0);
    e.repetidas += Number(p.repetidas ?? 0);
    e.errores += Number(p.errores ?? 0);
    e.runs += 1;
    if (r.status === "fail") e.status = "fail";
    else if (r.status === "warn" && e.status !== "fail") e.status = "warn";
    llmCostFact += Number(p.llm_cost_usd ?? 0);
    llmCallsFact += Number(p.llm_calls ?? 0);
    porCliente[c.slug] = e;
  }

  // Stats de cada agente sintético
  const monitor = runs.find((r) => r.agente_id === "monitor");
  const reparador = runs.find((r) => r.agente_id === "reparador");
  const limpiador = runs.find((r) => r.agente_id === "limpiador");
  const supervisor = runs.find((r) => r.agente_id === "supervisor");

  const ctx = {
    fecha: now.toLocaleDateString("es-CO", { timeZone: "America/Bogota", dateStyle: "long" }),
    clientes_total: clientesOp.length,
    facturacion_por_cliente: porCliente,
    monitor: monitor?.payload ?? null,
    reparador: {
      reparadas: reparador?.payload?.filas_reparadas?.length ?? 0,
      huerfanos: reparador?.payload?.pdfs_huerfanos?.length ?? 0,
      sin_pdf: reparador?.payload?.filas_sin_pdf?.length ?? 0,
      errores: reparador?.payload?.errores?.length ?? 0,
    },
    limpiador: {
      duplicados: limpiador?.payload?.duplicados_movidos ?? 0,
      recuperadas: limpiador?.payload?.facturas_recuperadas ?? 0,
      no_identificables: limpiador?.payload?.no_identificables ?? 0,
      costo_llm: Number(limpiador?.payload?.costo_llm_usd ?? 0),
    },
    supervisor: {
      ok: supervisor?.payload?.clientes_ok ?? 0,
      warn: supervisor?.payload?.clientes_warn ?? 0,
      fail: supervisor?.payload?.clientes_fail ?? 0,
      retriggers: supervisor?.payload?.retriggers_disparados ?? 0,
    },
    costo_anthropic_total_usd: llmCostFact + Number(limpiador?.payload?.costo_llm_usd ?? 0),
    llamadas_llm_total: llmCallsFact,
  };

  // 5. Llamar Claude
  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY ausente" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const prompt = `Sos el asistente operativo de Tomás, CEO de Operatto (SaaS contable para PyMEs colombianas).
Te paso el JSON con el estado de hoy de los 5 agentes que procesan facturas DIAN automáticamente.

CONTEXTO DE NEGOCIO:
- Cada cliente PyMe tiene un Sheet de contabilidad y una carpeta Drive con facturas
- "Procesadas" = facturas NUEVAS guardadas hoy en el Sheet del cliente
- "Repetidas" = facturas válidas que YA estaban (dedup correcto, no es un problema)
- "Saltadas" = correos que NO eran facturas (newsletters, notificaciones, etc.) — informativo
- "Errores" = fallos reales que necesitan atención
- "Huérfanos" = PDFs en Drive sin fila correspondiente en Sheet (gap a revisar)
- "Sin PDF" = filas en Sheet sin archivo en Drive (gap a revisar)
- "Retriggers" = el supervisor automáticamente redisparó algún agente porque detectó algo mal

DATOS DE HOY:
${JSON.stringify(ctx, null, 2)}

INSTRUCCIONES:
Generá un reporte ejecutivo de máximo 250 palabras, en español rioplatense/colombiano, formato bullet points + secciones. Estructurá así:

1. **Estado general** (1 línea): ¿día tranquilo, día con alertas, día con problemas?
2. **Qué hay que mirar HOY** (máximo 3 bullets, los más accionables — clientes específicos con problemas, errores, huérfanos altos). Si nada amerita atención, decilo.
3. **Resumen agregado** (1-2 líneas con números clave del día).
4. **Costo** (1 línea sobre Anthropic spend del día).

Tono: directo, sin floritura, como hablándole a un dueño de empresa que tiene 5 minutos. NO uses markdown headings (### etc), usá negritas con asteriscos. Empezá YA con el reporte, sin preámbulo.`;

  // Modelos a intentar en orden (si uno falla con 404/400, probar el siguiente)
  const modelosFallback = ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-3-5-haiku-latest"];
  let modelText = "";
  let lastError = "";
  for (const model of modelosFallback) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25_000); // edge functions tienen ~30s
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: 800, messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!claudeResp.ok) {
        const errTxt = await claudeResp.text();
        lastError = `Anthropic ${claudeResp.status} con modelo=${model}: ${errTxt.slice(0, 200)}`;
        console.error("[diagnostico-reporte]", lastError);
        if (claudeResp.status === 404 || claudeResp.status === 400) continue; // probar siguiente modelo
        return new Response(JSON.stringify({ error: lastError }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      const json = (await claudeResp.json()) as any;
      const block = (json.content ?? []).find((b: any) => b.type === "text");
      modelText = block?.text ?? "(sin contenido)";
      break; // éxito
    } catch (err: any) {
      lastError = `Claude failed con modelo=${model}: ${err.message}`;
      console.error("[diagnostico-reporte]", lastError);
      continue;
    }
  }

  if (!modelText) {
    return new Response(
      JSON.stringify({ error: `Todos los modelos fallaron. Último: ${lastError}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ reporte: modelText, contexto: ctx }),
    { headers: { "content-type": "application/json" } },
  );
};
