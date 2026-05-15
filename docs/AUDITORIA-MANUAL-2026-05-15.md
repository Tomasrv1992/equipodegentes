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
- Transcript de Fathom con la sesión perdida
- Screenshots que tomó durante la auditoría

Acá van a quedar tab por tab los hallazgos cuando lleguen.

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
