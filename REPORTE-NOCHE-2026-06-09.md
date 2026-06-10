# Reporte nocturno — 2026-06-09

## TL;DR (3 líneas)

- **Todos los Commits 1-6 escritos, typecheck verde, tests verde (7/7 reconcile-decide).** Rama `overnight/desatasco-dentilandia-2026-06-09` lista para revisión.
- **BLOQUEO documentado:** no existe `.env.local` en el repo → NO se pudieron correr los 3 dry-runs (Tarea 0 diagnóstico + Backfill + Reconcile). Tomás los corre manual en la mañana.
- **Causa raíz arquitectural atacada:** messageId en events + reconcile-labels con guarda de precedencia + test que prueba el caso de inversión-histórica está controlado. Listo para aplicar con sanity checks de la sección 6.

---

## 1. Estado del código

**Rama:** `overnight/desatasco-dentilandia-2026-06-09` (LOCAL, no pusheada)

**Commits realizados (7 total — los 6 del plan + run-local.ts):**

| # | SHA | Commit |
|---|-----|--------|
| 1 | `da615c7` | fix(perf): indices Supabase + filtro año/LIMIT en inspect-runs |
| 2 | `cbb5701` | fix(audit): Dashboard col E + LLM CC forceProcess + no XMLs Drive |
| 3 | `efa3421` | feat(events): messageId en factura_procesada payload |
| 4 | `95e1e59` | feat(diag): inspect-perdidas-background — diagnostica Sheet + events |
| 5 | `3377f8f` | feat(migration): backfill-messageid + reconcile_dumps + getAllEventsByYear |
| 6 | `87dc188` | feat(labels): reconcile-labels-background con guarda de precedencia + test |
| extra | `92cb417` | chore(scripts): run-local.ts para invocar endpoints LOCAL sin netlify dev |

**Verificación:**
- ✅ Typecheck (`npx tsc --noEmit`): EXITCODE=0
- ✅ Test unitario `reconcile-decide.test.ts`: **7/7 pasa** (incluyendo caso crítico "histórico con overlap → NO tocar")

**Archivos nuevos:**
- `docs/superpowers/migrations/0016_indices_agent.sql` (manual SQL Editor — NO via runner)
- `docs/superpowers/migrations/0017_reconcile_dumps.sql` (SÍ via runner)
- `netlify/functions/inspect-perdidas-background.mts`
- `netlify/functions/backfill-messageid-background.mts`
- `netlify/functions/reconcile-labels-background.mts`
- `agentes/Equipo-facturacion/lib/reconcile-decide.ts` (función pura testeable)
- `agentes/Equipo-facturacion/lib/__tests__/reconcile-decide.test.ts` (7 tests)
- `scripts/run-local.ts` (herramienta para invocar endpoints local sin netlify dev)

**Archivos modificados:**
- `netlify/functions/inspect-runs.mts` (filtro año + LIMIT)
- `netlify/functions/facturacion-background.mts` (propagar messageId al payload)
- `agentes/Equipo-facturacion/lib/pipeline.ts` (Dashboard col E, fallback LLM CC, no XMLs Drive, messageId en 4 returns)
- `agentes/Equipo-facturacion/lib/llm-extractor.ts` (forceProcess + _forced flag)
- `shared/agents-runtime/src/agent-events.ts` (messageId en FacturaEventPayload + helper getAllEventsByYear paginado)

---

## 2. Diagnóstico (Tarea 0) — NO se pudo correr

**Bloqueo:** falta `.env.local` con `FACTURACION_INTERNAL_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_OAUTH_WEB_CLIENT_ID/SECRET`, etc.

El endpoint `inspect-perdidas-background` está codeado y compilado. Para correr el diagnóstico manual en la mañana:

```bash
npx -y tsx scripts/run-local.ts netlify/functions/inspect-perdidas-background.mts \
  '{
    "clienteSlug":"dentilandia",
    "facturas":[
      {"proveedor_contains":"protokimicas","numero":""},
      {"proveedor_contains":"jeisy","numero":""},
      {"proveedor_contains":"exito","numero":"WE53314"},
      {"proveedor_contains":"exito","numero":"WE53313"},
      {"proveedor_contains":"lujan","numero":"JMLL18038"},
      {"proveedor_contains":"d1 s a s","numero":"39FL38036"},
      {"proveedor_contains":"comite asesor","numero":""}
    ]
  }' | tee diagnostico-tarea0.json
```

Después clasificar cada factura según la matriz 0C del plan:

| Patrón output | Camino |
|---------------|--------|
| `en_sheet:✓ + en_events>0 + sin messageId` | Backfill (5B) + Reconcile (6) → recuperado |
| `en_sheet:✓ + en_events:0` | Bug emisión event — re-emitir desde Sheet |
| `en_sheet:null + en_events:0 + en_descartado: motivo` | Falso negativo LLM — fix pipeline (Tarea 4 ya hecho) + reproceso acotado |
| `en_sheet:null + en_events:0 + en_descartado:[]` | Pipeline NUNCA las vio — force=true + ventana ampliada |

---

## 3. Backfill dryRun — NO se pudo correr

**Bloqueo:** mismo (`.env.local` faltante).

Para correrlo manual:

```bash
npx -y tsx scripts/run-local.ts netlify/functions/backfill-messageid-background.mts \
  '{"clienteSlug":"dentilandia","year":2026,"dryRun":true}' | tee backfill-dryrun.json
```

⚠️ **CHEQUEOS CRÍTICOS al revisar `backfill-dryrun.json`:**

1. **Sanity check del conteo (canario de paginación):**
   - `total_events_sin_messageid` debería estar cerca de ~654 (suma facturas Sheet 2026: Enero 56 + Feb 157 + Marzo 149 + Abril 143 + Mayo 126 + Junio ~23)
   - Si sale MUCHO MENOR (ej 100, 500) → `getAllEventsByYear` NO está paginando → reportar y NO aplicar

2. **Cobertura del backfill:**
   - `cobertura_porcentaje = matches_count / total_events_sin_messageid`
   - Esperado: ≥80%. Si <50% → normalización mal afinada
   - Revisar `sample_near_misses` con `reason: "no-dian-format"` para ver subjects reales y ajustar `parseDianSubject` si el formato difiere

3. **Near-misses tipo "numero-match-pero-nit-distinto":**
   - Si hay muchos → `nitMatch` o `normalizeNumero` no están tolerantes a algún caso real (ej. NIT con/sin DV)
   - Ya implementado: `nitMatch` tolera DV en cualquier lado sin asumir longitud 9 vs 10 (cubre cédulas freelancers)

---

## 4. Reconcile dryRun PRE-backfill — NO se pudo correr

**Bloqueo:** mismo.

```bash
npx -y tsx scripts/run-local.ts netlify/functions/reconcile-labels-background.mts \
  '{"clienteSlug":"dentilandia","year":2026,"dryRun":true}' | tee reconcile-dryrun-PREbackfill.json
```

**Recordar:** este es informativo, sub-reporta (pre-backfill `esFactura` está vacío). El reconcile que importa corre en la mañana DESPUÉS del backfill real. Solo confirma que el endpoint compila y responde.

---

## 5. Bloqueos / decisiones pendientes para Tomás

### Bloqueo único: `.env.local` faltante

No se pudieron correr los 3 dry-runs locales. El código está completo, typecheck OK, tests OK.

**Camino para desbloquear:**
- Tomás crea `.env.local` con las variables (`FACTURACION_INTERNAL_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_OAUTH_WEB_CLIENT_ID`, `GOOGLE_OAUTH_WEB_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `CREDENTIALS_VAULT_KEY`)
- Corre `npx -y tsx scripts/run-local.ts ...` manualmente para los 3 dry-runs (queries de la sección 2-4 arriba)
- Revisa cobertura backfill + sanity check conteo
- Sigue el checklist de la sección 6

### Decisiones que requieren input humano

Ninguna nueva. Las decisiones de diseño ya fueron tomadas durante el plan:
- Cuentas de cobro: umbral 0.2 SOLO en ruta forceProcess (acotado)
- XMLs Drive: NO subir
- Backfill: candidatos = Facturas ∪ Descartado, match (numero, nit) tolerante a DV

---

## 6. Checklist de arranque para la mañana

Orden exacto, ejecutar uno por uno verificando antes de pasar al siguiente:

- [ ] **1.** Crear `.env.local` con todas las env vars (ver lista en sección 5)
- [ ] **2.** Aplicar índices SQL — **MANUAL en Supabase SQL Editor**, uno por uno (CONCURRENTLY no corre en runner):
  ```sql
  create index concurrently if not exists idx_agent_runs_cliente_agente_started
    on agent_runs (cliente_id, agente_id, started_at desc);
  ```
  ```sql
  create index concurrently if not exists idx_agent_events_cliente_type_created
    on agent_events (cliente_id, tipo, created_at desc);
  ```
- [ ] **3.** Aplicar `0017_reconcile_dumps.sql` via runner (tabla + RPC `set_event_message_id`). Esta SÍ va via runner.
- [ ] **4.** Verificar 504 muerto: `curl .../inspect-runs -d '{"clienteSlug":"dentilandia","limit":3}'` debería responder <5s
- [ ] **5.** Correr Tarea 0 (inspect-perdidas dryRun via run-local.ts) → clasificar las 7 facturas con matriz 0C
- [ ] **6.** Correr backfill `dryRun:true` → revisar `cobertura_porcentaje` (≥80%) + `total_events_sin_messageid` vs ~654 (sanity check paginación) + `sample_near_misses`
- [ ] **7.** Si sanity check OK + cobertura ≥80% → backfill `dryRun:false`
- [ ] **8.** Verificar: `SELECT count(*) FROM agent_events WHERE tipo='factura_procesada' AND cliente_id=X AND payload->>'messageId' IS NOT NULL` debería ser ≥80% del total
- [ ] **9.** Reproceso acotado (cuentas de cobro que Tarea 4 ahora rescata):
  - **NO usar `skipDuplicateGuard:true`** — confunde y contradice safety
  - Opción A si endpoint `onlyMotivos` no está: `force:true` con concurrency:2, costo ~$3 Anthropic, riesgo timeout 15min
  - Opción B (mejor): agregar parámetro `onlyMotivos` que fetchea messageIds por motivo directo
  - Confirmar saldo Anthropic antes (~$3 estimado para Dentilandia solo)
- [ ] **10.** Reconcile `dryRun:true` → revisar `sample_fixes` (50) a ojo:
  - Casos típicos esperados: `add: [Facturas/2026], remove: [Descartado/2026]` para los Protokimicas que se recuperaron
  - Casos NO esperados: `remove: [Facturas/2026]` sobre algo que tenía Facturas (significa que la guarda falla — STOP)
- [ ] **11.** Si los fixes tienen sentido → reconcile `dryRun:false`
- [ ] **12.** Verificación manual:
  - Dashboard cuadra con conteo Sheet
  - Sheet Mayo/Abril/Junio: nuevas cuentas de cobro
  - Drive 2026-06: solo PDFs, sin .xml
  - Gmail Descartado/2026: sin facturas DIAN reales
- [ ] **13.** Test de aceptación: re-correr Tarea 0 con las mismas 7 facturas. Protokimicas, Jeisy etc. deben aparecer `en_sheet:✓`, en Facturas, fuera de Descartado.
- [ ] **14.** Si todo OK: `git rm` 3 endpoints viejos (apply-labels-historico, consolidate-todos-labels, consolidate-descartado-labels, fix-descartado-overlap) + 4 agentes muertos (monitor, reparador, limpiador, supervisor) — Commits 7 y 8 del plan
- [ ] **15.** Merge rama `overnight/desatasco-dentilandia-2026-06-09` a main + push
- [ ] **16.** (Sprint siguiente, NO hoy) Rotar `SUPABASE_SERVICE_ROLE_KEY` + `FACTURACION_INTERNAL_SECRET` antes de replicar a 9 clientes

---

## 7. Notas técnicas

### Sobre las migrations
- `0016_indices_agent.sql`: comentario interno dice "NO aplicar vía runner" — runner no la va a registrar, lo cual está OK
- `0017_reconcile_dumps.sql`: SÍ va vía runner (no CONCURRENTLY)

### Sobre el bug que casi se cuela (inversión-histórica)
La función `decide()` en `reconcile-decide.ts` tiene **guarda de precedencia**: si un email tiene label `Facturas/year` PERO no hay event con su messageId, NO TOCAR. Esto evita que reconcile invierta facturas históricas a Descartado.

Test caso 1 prueba exactamente esto: `histórico con overlap sin event → NO tocar`. Si alguien rompe la guarda, ese test falla y bloquea el merge.

### Sobre el N+1 evitado
`reconcile-labels-background` NO hace `gmail.users.messages.get()` por email. Solo 2 calls a `messages.list({ labelIds: [...] })` y arma sets de membresía. Para Dentilandia ~1646 emails, queda en segundos. Para Freshco también cabrá en 15min.

El backfill SÍ hace un GET por candidato (necesita el subject para `parseDianSubject`). Para Dentilandia ~1646 candidatos × ~200ms = ~5min. Para Freshco habrá que chunkear por mes en el sprint siguiente.

### Sobre `npx -y tsx`
El `-y` evita el prompt "Need to install tsx?" que cuelga al agente desatendido. NO usar `netlify dev` por la misma razón.

---

## 8. Resumen

Código causa-raíz aplicado, test crítico verde, escritura cero a producción esta noche. La mañana tiene un checklist accionable de 16 pasos, con sanity checks para parar si algo huele mal en cada etapa. El único riesgo conocido pendiente es el `parseDianSubject` (formato real DIAN no verificado) — el dryRun del backfill lo expone vía `sample_near_misses` antes de aplicar nada.

Si Tomás revisa primero `backfill-dryrun.json`, sección 3 del reporte le dice exactamente qué números mirar y qué umbral de cobertura aceptar.
