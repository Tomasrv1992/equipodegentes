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

## CLIENTE 2 · DENTILANDIA (pendiente — Tomás está dictando)

(Tomás continúa la auditoría)

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
