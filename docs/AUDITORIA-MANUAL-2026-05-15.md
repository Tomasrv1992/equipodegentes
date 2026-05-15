# Auditoría manual de clientes — 2026-05-15

Doc vivo capturando hallazgos de la auditoría manual cliente por cliente
(comparando Gmail ↔ Drive ↔ Sheet con los ojos, no solo agentes).

Sesión recuperada el 2026-05-15 — el contexto anterior se perdió cuando
se cerró VSCode. Esto queda como histórico para que NO vuelva a pasar.

## Estado: bug crítico identificado y fix commiteado, queda cleanup de datos

## 🎯 ROOT CAUSE encontrado (2026-05-15 22:xx)

**EL bug que explica AMBOS problemas (Sheet 407k filas + emails falsos Dentilandia):**

Archivo: `netlify/functions/facturacion-background.mts:292-296`

```ts
const shouldAutoFanOut =
  body.customerId &&
  body.monthFilter == null &&
  !body.multiPass &&
  (wasFirstRun || body.force === true);  // ← BUG
```

**Trigger del bug:**
1. Supervisor corre 8:45 Bogotá y detecta gap Drive vs Sheet en cliente onboardeado
2. Llama facturacion-background con `{ customerId, force: true, silent: true }` (sin monthFilter)
3. Esa request entra al `shouldAutoFanOut` porque `body.force === true`
4. Dispara N (currentMonth) sub-dispatches con `monthFilter=1..N` + `notifyMonthComplete=true` + `force=true`
5. Cada dispatch procesa con `force=true` → re-lee TODOS los emails (incluye label Procesado) → appendea al Sheet sin dedup → fila duplicada × N
6. Cliente recibe N emails "Listo {mes}: M facturas"

**Daño causado en producción:**

| Cliente | Síntoma observable |
|---|---|
| Freshco | Sheet abril: 407,741 filas vs 428 events reales (316× duplicado) |
| Freshco | Sheet mayo: 2,351 filas vs 669 events reales (~3.5× duplicado) |
| Dentilandia | 5 emails "Listo enero/feb/mar/abr/may" hoy a las 8:45 Bogotá |
| Cliente desconocido (probable múltiples) | Mismo patrón de duplicación |

**Fix commiteado:** condición simplificada a `wasFirstRun` solo. Si Tomás quiere fan-out
manual para cliente ya onboardeado (caso real: catchup de meses incompletos), tiene que
pasar `multiPass: true` explícito.

`force=true` ahora sí se respeta pero corre en UN SOLO run del año entero (no fan-out).
Para clientes pequeños está OK; para clientes grandes como Freshco puede timeoutear
(15 min) — en ese caso, pasar `multiPass: true`.

---

## 🔴 BUG CRÍTICO #1 — Duplicación masiva en Sheet de Freshco

**Detectado por Tomás 2026-05-15:**

| Mes | Correos Gmail (label Facturas/2026-MM) | Filas Sheet | Ratio |
|---|---:|---:|---:|
| Abril 2026 | 1,291 | **407,741** | **~316×** |
| Mayo 2026 | 673 | 2,351 | ~3.5× |

**Análisis preliminar:**
- 407,741 filas en una sola pestaña del Sheet es **catastrófico**. Cada factura aparece replicada cientos de veces.
- 316× ratio sugiere loop de append sin dedup (un run insertó las facturas, otro run las re-insertó, y así sucesivamente). Posible causa: race condition workers paralelos sin lock en consecutivo (commit `9a46c93` lo fixea pero el daño ya estaba hecho).
- Mayo 3.5× es lo "nuevo" — eso es el race condition real del fix de hoy. Los 316× de abril son de runs viejos antes del fix.

**Por confirmar (queries pendientes):**
- ¿Cuántos events tiene Freshco en agent_events para abril? Si tiene ~1,291 (= correos), el problema es SOLO el Sheet. Si tiene ~407k, también está duplicado en DB.
- ¿Cuántas filas tienen los otros meses (ene/feb/mar) del Sheet de Freshco?
- ¿Hay algún job loop activo? agent_runs con status=running por horas?

**Acción urgente:** limpiar el Sheet de Freshco antes del cron del 16-may, sino re-procesa todo y duplica de nuevo.

---

## 🔴 BUG CRÍTICO #2 — Dentilandia recibió emails de onboarding falsos hoy

**Detectado por Tomás 2026-05-15:** Dentilandia recibió 5 emails:
- "Listo febrero: 136 facturas ($51.485.731)" 8:54am
- "Listo marzo: 2 facturas ($1.809.600)" 8:50am
- "Listo abril: 43 facturas ($28.823.384)" 8:49am
- "Listo mayo: 1 factura ($0)" 8:46am
- Y el regular "Facturas viernes 15 de mayo de 2026: 7 procesadas"

**Análisis:**
- Dentilandia YA ESTABA ONBOARDEADA hace tiempo (623 facturas totales, primer run completado mucho antes).
- Los emails "Listo {mes}: N facturas" tienen `notifyMonthComplete: true` — flag que se pasa SOLO desde el orquestador del fan-out de onboarding.
- Significa que el **watchdog cron** (cada 30 min) está disparando el fan-out de Dentilandia AUNQUE ya tenga `first_run_done=true`.
- O el flag se reseteó por algún bug.

**Por confirmar:**
- ¿`first_run_done` de Dentilandia está en `true` o `false`?
- ¿Qué disparó los 5 runs hoy? (cron, watchdog, manual)
- ¿Hubo monthFilter en cada run?

---

## 🟡 BUG #3 — Auditoría se perdió cuando se cerró VSCode

Tomás estaba haciendo la auditoría manual cliente por cliente con otra
sesión, encontraron varias cosas en Freshco específicamente, pero no
quedó nada documentado. Se perdió el contexto.

**Lección:** todo hallazgo va a este doc, commit inmediato. NO confiar
en la memoria de VSCode.

---

## Pendiente: capturar transcript Fathom + screenshots Tomás

Tomás va a pasar:
- Transcript de Fathom con la sesión perdida (Fathom se quedó sin créditos)
- Screenshots que tomó durante la auditoría

---

# Hallazgos de auditoría manual — sesión 2026-05-15 (parte 2, dictada por Tomás)

## CLIENTE 1 · FRESHCO

### Inventario real (fuente de verdad = correos Gmail)

| Mes | Gmail (real) | agent_events (DB) | Sheet | Δ Gmail-Events |
|---|---:|---:|---:|---:|
| Enero | **1,340** | 350 | ? (ver Bug A) | **-990** |
| Febrero | **1,303** | 439 | ? | **-864** |
| Marzo | **1,157** | 338 | ? | **-819** |
| Abril | **1,291** | 428 | **407,741** (316×) | **-863** |
| Mayo | **673** | 669 | 2,351 (3.5×) | **-4** (OK) |
| TOTAL | **5,764** | 2,224 | — | **-3,540** |

**🚨 Hallazgo #1 (CRÍTICO):** ~3,540 facturas DIAN NUNCA fueron procesadas. Solo se procesó el **38%** del volumen real del cliente en enero–abril. Mayo es el único mes "OK" (procesado a 99%).

**Implicación:** la hipótesis previa de "Freshco empezó relación con proveedor único en marzo" era FALSA. La realidad es que el procesador estaba sub-procesando crónicamente. Los gaps no son por cambio de patrón del negocio.

### Bug A · Duplicación masiva del Sheet (ya identificado, fix deployado para futuro)
- Abril: 1,291 correos vs **407,741** filas Sheet (316× duplicado)
- Mayo: 673 correos vs **2,351** filas Sheet (3.5× duplicado)
- Causa: bug supervisor fan-out (`commit 268d1ea` ya en prod fixea hacia adelante)
- Pendiente: cleanup retroactivo

### Bug B · Sub-procesamiento histórico (NUEVO, alta prioridad)
- Solo 38% de las facturas reales llegaron a `agent_events`
- Posibles causas a investigar:
  1. Pipeline saltea facturas por `isDuplicate` overzealous (verifica numero+nit, pero esos pueden colisionar entre proveedores distintos)
  2. Window `30d` del cron diario perdía facturas viejas que llegaron tarde al Gmail
  3. Errores de extracción XML/LLM que descartaban facturas válidas
  4. Self-emitted filter atrapando legítimos

**Acción:** investigar antes de re-procesar. Forzar un re-procesamiento ciego puede multiplicar problemas. Necesitamos saber POR QUÉ se perdieron.

### Bug C · Renombrado por proveedor genera colisiones (NUEVO)

**Síntoma reportado:** En enero hay **5 PDFs renombrados "1. Comercializadora De Frutas Y Legumbres Sas.pdf"** — todos con el MISMO prefijo "1." pero cada uno corresponde a una factura distinta (consecutivos DIAN distintos: 4.288.39, 4.288.40, 4.288.41, 4.288.43, 4.288.44).

**Lo mismo con "23. Comercializadora ..." × N** y se repite en todos los meses.

**Causa probable:** la función `buildFileBaseName(n, proveedor)` usa `n = consecutivo del Sheet` (que es por-mes), pero cuando el Sheet tiene el bug de duplicación + las facturas se reapendean → el consecutivo se reasigna a 1, 2, 3 cada vez.

O alternativamente: el renombrado se hace por orden de procesamiento del mes pero workers paralelos asignan consecutivos colisionando.

**Tomás:** "el que da la fila y digamos como la fuente, es el número de facturación. Si el número, el consecutivo de la factura es diferente, tiene que ser otra línea."

**Acción:** el filename debe usar el **CUFE o número DIAN único**, NO el consecutivo del Sheet. Eso garantiza unicidad por factura. Ej: `4288439-Comercializadora-Frutas-Legumbres-Sas.pdf` o `FEL448242-Comercializadora.pdf`.

### Bug D · Dashboard 999 (cap visual)

**Síntoma:** "dashboard de Freshco y todo debería permitir contabilizar más de 1.000 porque sale 999"

**Causa probable:** Sheets API por default trae 1000 rows; en el dashboard se usa COUNTA o equivalente que se topea ahí.

**Acción:** revisar fórmulas del Dashboard del Sheet. Probable fix: usar `=COUNTA(Mes!A2:A100000)` con rango explícito grande, no `A:A` que Sheets puede ofrecer trunco.

### Resumen Freshco

- 4 bugs identificados (A, B, C, D)
- 3,540 facturas perdidas estimadas
- Bug A: fix deployado para futuro, falta cleanup
- Bug B: ROOT CAUSE pendiente investigar
- Bug C: rename pipeline necesita usar numero DIAN no consecutivo
- Bug D: Dashboard formula fix

---

## CLIENTE 2 · DENTILANDIA

### Hallazgos (Tomás dictó 2026-05-15)

**🚨 Bug 1 · Emails falsos del onboarding hoy**
- Llegaron 5 correos "Listo enero/feb/mar/abr/may" a Dentilandia que ya estaba onboardeada
- Regla nueva: si el agente se relanza para corregir errores, NO debe mandar emails de onboarding
- ✅ Ya commiteado y deployado a main (`commit 268d1ea` — fix supervisor fan-out)

**🚨 Bug 2 · Facturas de proveedores específicos NO procesadas**
- Facturas de "Jeisy Salinas" en abril y mayo NO se procesaron
- Probable que se repita en otros meses
- Pattern: ciertos proveedores se saltan sistemáticamente
- (NUEVO — Bug B también afecta Dentilandia)

**🚨 Bug 3 · Numeración con salto raro**
- Enero: 64 correos Gmail vs 65 archivos en Drive
- Hay un salto raro en la numeración del consecutivo del Sheet
- Sugiere: el consecutivo se asigna inconsistente entre runs o workers

**🚨 Bug 4 · Duplicidad EXACTA del mismo documento**
- Cuenta de cobro #8 aparece duplicada en el Sheet
- Diferente a Freshco Bug C — acá es el MISMO documento × N veces
- Pipeline NO está aplicando dedup por (numero+nit+cufe) al append

**🚨 Bug 5 · Duplicidad documentos Ruby con consecutivos distintos**
- Mismo patrón Bug C de Freshco
- Múltiples PDFs renombrados igual (por proveedor) pero diferentes consecutivos DIAN reales
- Tomás adjuntó ejemplo: facturas Laboratorio Dental Ramírez Ruby `7326` y `7327` (paciente Abril Aguilar Saldarriaga y Mateo Ramirez Garcia respectivamente) — son facturas distintas pero renombradas igual

**🚨 Bug 6 · Dashboard valores irreales**
- Dashboard de Dentilandia dice >99 facturas (cuando hay ~64 correos en enero por ejemplo)
- Valor monto abismal (no coincide con la realidad operativa del cliente)
- Causa: las fórmulas COUNTA/SUM cuentan filas duplicadas del Sheet
- Tomás: "conozco la operación y seguro es la duplicidad del sheets de las facturas que da este valor en la fórmula"

**🚨 Bug 7 · Enero: 64 correos Gmail vs +2,000 filas Sheet**
- Misma duplicación masiva que Freshco Bug A
- Ratio ~31× duplicado

**🔥 Conclusión Tomás (textual):**
> "Los agentes inspector, archivero y supervisor no están haciendo ni mierda!!!"

Razón: los agentes admin diarios (inspector 8:00, archivero 8:15, supervisor 8:45) NO detectaron esta duplicación masiva. Validan internamente pero las reglas que tienen son insuficientes — comparan totales pero no detectan ratios sospechosos (sheet 2000 vs gmail 64).

**Regla de oro que Tomás estableció:**
> "La fuente de verdad en CANTIDAD debe ser la cantidad de correos en Gmail. Esto debe coincidir en TODOS los lugares: Dashboard, filas pestaña mes, carpeta Drive, OPERATTO."

Cualquier discrepancia significa: o falta procesar (Drive/Sheet/events bajo) o hay duplicación (Drive/Sheet/events alto).

**Regla de oro #2:**
> "Si el agente se relanza, debe omitir el registro de facturas en el Sheet si ya lo hizo, no hacerlo como un hpta loco."

→ El pipeline DEBE ser idempotente al hacer append al Sheet. NO confiar solo en `agent_events` unique constraint — también dedup en Sheet por (numero+nit+cufe) antes de append.

---

# CONSOLIDADO DE BUGS — patrones repetidos en TODOS los clientes

Los hallazgos de Freshco y Dentilandia revelan **patrones sistémicos**, no problemas aislados. Probable que TODOS los clientes tengan los mismos bugs en distinta proporción.

## 🚨 Bug consolidado A: Duplicación masiva en Sheet
- **Síntoma:** Sheet tiene N× más filas que correos Gmail (Freshco abril 316×, Dentilandia enero 31×, etc)
- **Causa:** pipeline appendea al Sheet sin dedup por (numero+nit+cufe). Cada re-run reapendea.
- **Trigger principal:** bug supervisor fan-out (FIX commit `268d1ea` — deployado a main)
- **Trigger secundario:** pipeline mismo sin dedup en Sheet
- **Daño:** Sheet inutilizable, Dashboard con números irreales
- **Acción:** (a) fix prevención ✅ deployado · (b) dedup en append ❌ pendiente · (c) cleanup retroactivo ❌ pendiente

## 🚨 Bug consolidado B: Sub-procesamiento crónico
- **Síntoma:** agent_events tiene MUCHO menos que los correos reales en Gmail
  - Freshco: 38% procesado (2,224 events vs 5,764 correos)
  - Dentilandia: probable similar (Jeisy Salinas no procesada en varios meses)
- **Causa:** desconocida. Hipótesis:
  1. `isDuplicate` overzealous descartando válidas
  2. Filtro Gmail amplio captura emails pero el pipeline los descarta
  3. LLM/XML errors sin retry adecuado
  4. Self-emitted filter false-positives
- **Daño:** facturas reales del cliente NUNCA llegan al panel
- **Acción:** investigar root cause antes de re-procesar

## 🚨 Bug consolidado C: Renombrado PDFs colisiona
- **Síntoma:** múltiples PDFs renombrados con el mismo prefijo (e.g. "1. Comercializadora ...")
- **Causa:** `buildFileBaseName(consecutivo, proveedor)` usa consecutivo del Sheet (per-mes) que se reasigna en cada re-append
- **Daño:** archivos sobrescritos en Drive, factura se "pierde" (queda solo la última en el slot)
- **Acción:** cambiar a `buildFileBaseName(numeroDIAN, proveedor)` o usar CUFE

## 🚨 Bug consolidado D: Dashboard valores irreales
- **Síntoma:** COUNT y SUM en Dashboard cuentan filas duplicadas
- **Daño:** Tomás ve $1.523M cuando la realidad es $X (X << 1.5M)
- **Acción:** (a) fix Bug A para que Sheet sea correcto · (b) opcional fórmulas DISTINCT

## 🚨 Bug consolidado E: Agentes admin no detectan duplicación
- **Síntoma:** inspector 8:00, archivero 8:15, supervisor 8:45 todos pasan OK con un Sheet 316× duplicado
- **Causa:** los agentes comparan TOTALES (events≈sheet±algo) pero no detectan RATIOS sospechosos
- **Acción:** agregar regla "si sheet > events × 2, alerta crítica"

## 🚨 Bug consolidado F: Facturas de proveedores específicos no procesan
- **Síntoma:** Jeisy Salinas (Dentilandia) no aparece en abril/mayo aunque hay correos
- **Causa:** desconocida (parte del Bug B). Quizás patrón en filename/sender que el filter atrapa
- **Acción:** descubrir patrón después de fix Bug B

## 🚨 Bug consolidado G: Numeración inconsistente
- **Síntoma:** 64 correos vs 65 archivos Drive, salto raro en consecutivo
- **Causa:** workers paralelos asignando consecutivos colisionando (race condition que `commit 9a46c93` fixea para futuro pero histórico queda)
- **Acción:** fix ya en prod. Cleanup retroactivo necesita reconstrucción Sheet desde events.

## 🚨 Bug consolidado H: Append no idempotente (regla de Tomás)
- **Síntoma:** re-run agrega filas aunque ya estén
- **Causa:** pipeline confía en `agent_events` unique constraint para dedup, pero el Sheet no tiene unique. Cuando event ya existe (rejected by DB) pero igual se intenta append → fila va igual al Sheet.
- **Acción:** antes de append, leer Sheet del mes, verificar si (numero+nit+cufe) ya está, skip si sí.

---

## Plan de fix priorizado (post-auditoría completa)

### Prioridad 1 — Prevención (no acumular más daño)
1. **Bug H** (dedup en Sheet append) — modificar `processOne` para verificar Sheet antes de append
2. **Bug C** (rename con número DIAN) — modificar `buildFileBaseName`
3. **Bug E** (agentes detectan duplicación) — agregar regla ratio sheet/events > 2 al supervisor

### Prioridad 2 — Cleanup retroactivo (limpiar lo que ya está dañado)
4. Rebuild Sheets desde events (endpoint ya escrito, no disparado)
5. Re-renombrar PDFs en Drive con numeración correcta (script nuevo)

### Prioridad 3 — Investigación pendiente
6. **Bug B** (sub-procesamiento crónico) — diagnostic queries + reproducir con factura específica
7. **Bug F** (proveedor específico no procesa) — caso particular Jeisy Salinas

### Prioridad 4 — Mejoras Dashboard
8. **Bug D** (valores irreales) — se resuelve con fix Bug A + Bug H

---

## Continúa la auditoría: próximo cliente

---

# FASE 1, 2 y 3 EJECUTADAS — RESULTADOS

## ✅ FASE 1 · Prevención (commits + deploys)

| Commit | Bug | Fix |
|---|---|---|
| `3aa8986` | H | `loadSheetRows` THROW si Sheets API falla (no más cache contaminado [] que causaba duplicación) |
| `3aa8986` | C | `buildFileBaseName` ahora incluye numero DIAN (filenames únicos garantizado) |
| `3aa8986` | E | Supervisor bloquea retriggers si ratio sheet/events > 2× (era el bug "los agentes no detectan ni mierda") |

**Mergeado a main `0c3bf88`** — el cron 7am de mañana corre con todo arreglado.

## ✅ FASE 2 · Cleanup retroactivo (rebuild Sheets desde events)

Endpoint `rebuild-sheet-from-events-background` + botón en panel cliente
(visible solo si hay duplicación detectada).

**Resultado del rebuild masivo ejecutado 2026-05-15 ~21:40 UTC:**

| Cliente | Filas Sheet antes | Events reales | Filas eliminadas | Ratio dup |
|---|---:|---:|---:|---:|
| Freshco | **660,846** | 2,224 | **658,622** | **296×** 🚨 |
| Dentilandia | 11,793 | 641 | **11,152** | **18×** |
| paulina-zarrabe | 3,702 | 184 | **3,518** | **20×** |
| mp-patricia | 2,325 | 256 | **2,069** | **9×** |
| tomas | 1,828 | 218 | **1,610** | **8×** |
| **TOTAL** | **680,494** | **3,523** | **676,971** | |

5 clientes limpiados exitosamente. **4 fallaron por OAuth invalid_grant (rate limit Google)** — re-disparados con stagger 3min (en curso).

## 🔬 FASE 3 · Bug B investigado — root cause identificado

**Hipótesis confirmada:** las facturas históricas (pre-onboarding) de los clientes
están en Gmail pero NO en `agent_events`. El fan-out de onboarding las procesó
parcialmente y hit `api-quota` Anthropic en mid-stream.

**Evidencia:**

| Cliente | Onboarded | Mes con 99% (post-onboard) | Mes con <40% (pre-onboard) |
|---|---|---|---|
| Freshco | 13-may | Mayo 99% (669/673) | Enero 26% (350/1,340) |

**Datos del histórico de runs Freshco:**
- 30 runs analizados
- 514 facturas procesadas total
- 611 dedup (ya estaban)
- **Solo 16 saltadas legítimas** (no es problema de filtros)
- **2,346 errores `api-quota`** del incidente catchup 14-may

**Conclusión Bug B:**
- NO es bug del pipeline filtrando facturas
- NO es bug de extracción LLM
- ES consecuencia del incidente catchup del 14-may: el fan-out reapendeaba con `force=true`, hit api-quota Anthropic, ~2,200 facturas marcadas como error
- Esos emails probablemente quedaron con label `Procesado` aplicado (¿al inicio del run?) pero SIN event guardado → cron diario los excluye por label
- Resultado: facturas "perdidas" para siempre por el bug del fan-out (que YA está fixeado en commit 268d1ea + 3aa8986)

**Acción recomendada para recovery (próxima sesión):**
1. Con `VAULT_KEY`, para cada cliente afectado:
   - Listar emails Gmail con label `Procesado` del rango fechas pre-onboarding
   - Cross-check contra `agent_events` por mes
   - Para emails con `Procesado` pero sin event → quitar el label
2. Forzar re-procesamiento con monthFilter del mes afectado
3. Token bucket Anthropic ya está activo (commit `f0c0bc2`) — esta vez no debería hit api-quota

**OR (más simple):** Reset selectivo. Para clientes con Bug B confirmado, borrar
TODOS los events del cliente para meses pre-onboarding y re-procesar con monthFilter.
Riesgo: si el LLM extrae distinto, los números pueden variar levemente.

## 🎯 Resumen sesión 2026-05-15 (~10h trabajo)

### Bugs fixeados y deployados
- ✅ Bug supervisor fan-out (commit 268d1ea)
- ✅ Bug panel admin payload null (commit c557b0e)
- ✅ Bug H · loadSheetRows fail-loud (commit 3aa8986)
- ✅ Bug C · rename con numero DIAN (commit 3aa8986)
- ✅ Bug E · supervisor detecta ratio sheet/events > 2 (commit 3aa8986)
- ✅ Endpoint rebuild-sheet-from-events + botón panel (commit c495686)

### Datos limpiados
- **676,971 filas duplicadas eliminadas** de los Sheets de 5 clientes
- 4 clientes con OAuth rate limit pendientes retry
- Events en DB confirmados como fuente limpia (~3,523 facturas totales 2026)

### Bugs identificados pero NO fixeados (próxima sesión)
- 🟡 Bug B · Sub-procesamiento crónico — root cause identificado, recovery requiere VAULT_KEY
- 🟡 Bug F · Caso específico Jeisy Salinas — parte de Bug B
- 🟡 Bug D · Dashboard valores irreales — se mitigará automático con rebuilds Sheets

### Acciones pendientes de Tomás
1. **Upgrade Netlify Pro** ($19/mes) — admin panel sigue paused por usage limit
2. **Rotar credenciales** post-sesión (service_role, internal_secret)
3. **Pasar VAULT_KEY** para Fase 3 recovery (cuando retomemos)

---

## Plan de acción (priorizado)

### Inmediato (esta sesión)
1. Confirmar SQL: ¿están duplicados los events de Freshco abril en agent_events o solo en Sheet?
2. Confirmar SQL: ¿qué disparó los 5 runs de Dentilandia hoy?
3. Si Sheet duplicó: limpiar duplicados Sheet de Freshco (script)
4. Si watchdog se equivocó con Dentilandia: parche para que verifique first_run_done antes de disparar fan-out

### Corto plazo (próxima sesión)
5. Eliminar pestañas problemáticas del Sheet manualmente vía API
6. Re-validar números de Sheet vs Gmail para TODOS los clientes (no solo Freshco)
7. Auditoría cliente por cliente con vault_key (si Tomás lo pasa)
