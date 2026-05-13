// Edge function: /api/operacion-reporte-mes
//
// Genera un reporte ejecutivo MENSUAL para Tomás (visión gerencial),
// distinto del diagnóstico diario. Resume el mes en curso, compara contra
// el mes anterior, y sugiere acciones para el mes siguiente.

import type { Context } from "@netlify/edge-functions";

export default async (request: Request, _context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

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

  // Calcular rangos de fecha (mes actual + anterior en Bogotá)
  const now = new Date();
  const mesActualStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const mesPrevStart = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const mesPrevEnd = mesActualStart;

  const sbHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  // 1. Clientes activos
  const clientesResp = await fetch(
    `${supabaseUrl}/rest/v1/clientes?activo=eq.true&select=id,slug,nombre,created_at`,
    { headers: sbHeaders },
  );
  const clientes = (await clientesResp.json()) as Array<{
    id: string;
    slug: string;
    nombre: string;
    created_at: string;
  }>;
  const synthetic = new Set(["monitor", "reparador", "limpiador", "supervisor", "owner"]);
  const clientesOp = clientes.filter((c) => !synthetic.has(c.slug));

  // 2. Facturas del mes actual + anterior (por payload->>fecha)
  const [factMesResp, factPrevResp] = await Promise.all([
    fetch(
      `${supabaseUrl}/rest/v1/agent_events?tipo=eq.factura_procesada&agente_id=eq.facturacion&payload->>fecha=gte.${mesActualStart}&select=cliente_id,payload`,
      { headers: sbHeaders },
    ),
    fetch(
      `${supabaseUrl}/rest/v1/agent_events?tipo=eq.factura_procesada&agente_id=eq.facturacion&payload->>fecha=gte.${mesPrevStart}&payload->>fecha=lt.${mesPrevEnd}&select=cliente_id,payload`,
      { headers: sbHeaders },
    ),
  ]);
  const factMes = (await factMesResp.json()) as Array<{ cliente_id: string; payload: any }>;
  const factPrev = (await factPrevResp.json()) as Array<{ cliente_id: string; payload: any }>;

  // 3. Agregar por cliente
  const porCliente: Record<string, { nombre: string; mes: number; mes_prev: number; monto_mes: number }> = {};
  for (const c of clientesOp) {
    porCliente[c.slug] = { nombre: c.nombre, mes: 0, mes_prev: 0, monto_mes: 0 };
  }
  const clienteIdToSlug = new Map(clientesOp.map((c) => [c.id, c.slug]));
  for (const f of factMes) {
    const slug = clienteIdToSlug.get(f.cliente_id);
    if (!slug || !porCliente[slug]) continue;
    porCliente[slug].mes += 1;
    porCliente[slug].monto_mes += Number(f.payload?.total ?? 0);
  }
  for (const f of factPrev) {
    const slug = clienteIdToSlug.get(f.cliente_id);
    if (!slug || !porCliente[slug]) continue;
    porCliente[slug].mes_prev += 1;
  }

  const totalMes = Object.values(porCliente).reduce((s, v) => s + v.mes, 0);
  const totalPrev = Object.values(porCliente).reduce((s, v) => s + v.mes_prev, 0);
  const montoTotalMes = Object.values(porCliente).reduce((s, v) => s + v.monto_mes, 0);
  const clientesActivosMes = Object.values(porCliente).filter((v) => v.mes > 0).length;
  const clientesActivosMesPrev = Object.values(porCliente).filter((v) => v.mes_prev > 0).length;

  // 4. Top 3 clientes que crecieron / cayeron
  const conDelta = Object.entries(porCliente)
    .filter(([, v]) => v.mes_prev > 0 || v.mes > 0)
    .map(([slug, v]) => ({
      slug,
      nombre: v.nombre,
      mes: v.mes,
      mes_prev: v.mes_prev,
      delta_pct: v.mes_prev > 0 ? Math.round(((v.mes - v.mes_prev) / v.mes_prev) * 100) : null,
    }));
  const top3Crecieron = [...conDelta]
    .filter((c) => c.delta_pct !== null && c.delta_pct > 0)
    .sort((a, b) => (b.delta_pct ?? 0) - (a.delta_pct ?? 0))
    .slice(0, 3);
  const top3Cayeron = [...conDelta]
    .filter((c) => c.delta_pct !== null && c.delta_pct < 0)
    .sort((a, b) => (a.delta_pct ?? 0) - (b.delta_pct ?? 0))
    .slice(0, 3);

  // 5. Costo Anthropic del mes (sum llm_calls × $0.003)
  const runsMesResp = await fetch(
    `${supabaseUrl}/rest/v1/agent_runs?agente_id=eq.facturacion&started_at=gte.${mesActualStart}&select=payload`,
    { headers: sbHeaders },
  );
  const runsMes = (await runsMesResp.json()) as Array<{ payload: any }>;
  const llmCallsMes = runsMes.reduce((s, r) => s + Number(r.payload?.llm_calls ?? 0), 0);
  const costoAnthropicMes = Math.round(llmCallsMes * 0.003 * 100) / 100;
  const costoPorFactura = totalMes > 0 ? Math.round((costoAnthropicMes / totalMes) * 1000) / 1000 : 0;

  const ctx = {
    mes_actual: now.toLocaleDateString("es-CO", { month: "long", year: "numeric" }),
    clientes_totales: clientesOp.length,
    clientes_activos_mes: clientesActivosMes,
    clientes_activos_mes_anterior: clientesActivosMesPrev,
    facturas_mes: totalMes,
    facturas_mes_anterior: totalPrev,
    crecimiento_pct: totalPrev > 0 ? Math.round(((totalMes - totalPrev) / totalPrev) * 100) : null,
    monto_total_cop: Math.round(montoTotalMes),
    horas_ahorradas: Math.round((totalMes * 10) / 60), // 10 min/factura
    top_3_crecieron: top3Crecieron,
    top_3_cayeron: top3Cayeron,
    costo_anthropic_usd: costoAnthropicMes,
    costo_por_factura_usd: costoPorFactura,
  };

  const anthropicKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY ausente" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const prompt = `Sos el asistente gerencial de Tomás, CEO de Operatto (SaaS contable para PyMEs colombianas, 10 clientes hoy).
Te paso el resumen del mes en curso para que generes un reporte ejecutivo MENSUAL (no operativo).

DATOS DEL MES:
${JSON.stringify(ctx, null, 2)}

INSTRUCCIONES:
Generá un reporte ejecutivo de máximo 280 palabras, en español rioplatense/colombiano. Estructurá así:

1. **Highlights del mes** (1-2 líneas): ¿el mes va bien, regular, mal? Mencioná el crecimiento vs mes anterior.
2. **Lo bueno** (1-2 bullets): clientes que crecieron, métricas que mejoraron.
3. **Para mover el mes que viene** (2-3 bullets accionables): clientes que cayeron necesitan follow-up, decisiones de capacity, oportunidades comerciales (ej. "tomas92 creció 80% → ¿cliente más para esta vertical?").
4. **Economics** (1 línea): costo Anthropic, costo/factura, comparación con valor entregado.

Tono: gerencial, directo, accionable. NO uses headings markdown (###), usá negritas con asteriscos. Empezá YA, sin preámbulo.`;

  const modelosFallback = ["claude-haiku-4-5-20251001", "claude-haiku-4-5", "claude-3-5-haiku-latest"];
  let modelText = "";
  let lastError = "";
  for (const model of modelosFallback) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25_000);
      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!claudeResp.ok) {
        const errTxt = await claudeResp.text();
        lastError = `Anthropic ${claudeResp.status} con modelo=${model}: ${errTxt.slice(0, 200)}`;
        console.error("[operacion-reporte-mes]", lastError);
        if (claudeResp.status === 404 || claudeResp.status === 400) continue;
        return new Response(JSON.stringify({ error: lastError }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      const json = (await claudeResp.json()) as any;
      const block = (json.content ?? []).find((b: any) => b.type === "text");
      modelText = block?.text ?? "(sin contenido)";
      break;
    } catch (err: any) {
      lastError = `Claude failed con modelo=${model}: ${err.message}`;
      console.error("[operacion-reporte-mes]", lastError);
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
