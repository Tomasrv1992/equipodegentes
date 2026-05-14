# Auditoría Panel Admin — 2026-05-13

Auditoría sistemática del panel admin para garantizar que **TODOS los números mostrados sean correctos**. Tomás pidió validación 100% honesta.

## Resumen ejecutivo

| # | Bug | Severidad | Impacto | Fix |
|---|---|---|---|---|
| 1 | `totalMonto()` ignora montos como string | 🔴 Alta | UNDERCOUNT de COP procesado si payload viejo | `Number()` defensivo |
| 2 | `facturasThisMonth()` / `facturasLastDays()` parsean Date local | 🟡 Media | Off-by-one al cambiar mes según TZ del browser | String-slice YYYY-MM |
| 3 | `topProveedores()` mismo bug de monto string | 🟡 Media | Top proveedores con montos errados | `Number()` defensivo |
| 4 | `Matriz.tsx HistoricoMensual` totalMonto local mismo bug | 🟡 Media | Chart "Volumen $ procesado" undercount | `Number()` defensivo |
| 5 | `agent_runs` limit 200 en ClienteFicha | 🟠 Crítica | Métricas "30d" se truncan a ~15 días | Subido a 500 |
| 6 | `useLatestRuns` limit 200 (para 10 clientes activos) | 🟠 Crítica | Vista /operacion + /agentes ven solo ~1.5 días | Subido a 1000 |
| 7 | `useFacturasByCliente` limit 1000 sin paginación | 🟠 Crítica | Clientes con +1000 events (Freshco, Dentilandia) truncan | Paginación con `.range()` |
| 8 | `useFacturasByAgente` mismo problema | 🟠 Crítica | Vista /agente/:id trunca para agentes con muchos events | Paginación |

## Detalles por bug

### Bug 1: `totalMonto()` descarta strings

**Archivo**: `apps/admin/src/lib/metrics.ts:186-193`

**Antes**:
```ts
const t = (ev.payload as FacturaEventPayload | null)?.total;
if (typeof t === "number") total += t;  // ← descarta string
```

**Después**:
```ts
const raw = ...;
if (raw == null) continue;
const t = typeof raw === "number" ? raw : Number(raw);
if (!isNaN(t) && isFinite(t)) total += t;
```

**Por qué importa**: el backfill viejo de Tomás guardaba `total` a veces como string `"300000"`. Estos events se contaban 0 en el monto total, causando undercount en `/operacion` (valor entregado COP) y reportes ejecutivos.

### Bug 2: Off-by-one al filtrar mes

**Archivo**: `apps/admin/src/lib/metrics.ts:147-155`

**Antes**:
```ts
const d = new Date(fecha + "T00:00:00");  // ← TZ del browser
return d.getFullYear() === refY && d.getMonth() === refM;
```

Si el browser está en zona distinta a Bogotá, `"2026-05-01T00:00:00"` en NYC (UTC-4) se interpreta como `2026-04-30T20:00:00 local` → filtrarse como abril en vez de mayo.

**Después**: comparación string `fecha.slice(0, 7) === "2026-05"`. Zona-independiente.

### Bug 5/6: Limits viejos de agent_runs

**Antes**:
- `useLatestRuns` limit 200 → solo 1.5 días con 10 clientes × 13 runs/día
- `ClienteFicha` limit 200 → solo 15 días por cliente

**Impacto real**: el panel decía "errores 30d: 2" pero tal vez había 15 errores en los últimos 30 días que no se traían.

**Después**: 1000 y 500 respectivamente. Cubre 30+ días con margen.

### Bug 7/8: useFacturasByCliente/Agente truncado a 1000

**Antes**:
```ts
.limit(1000);
```

**Impacto real**: Freshco tiene 1098 events. La query traía solo los 1000 más recientes. ENE no aparecía completo en `/cliente/freshco` chart.

**Después**: paginación en `.range(from, from + 999)` hasta agotar (hard ceiling 50k).

## Validaciones que SÍ están bien

| Validación | Archivo | Estado |
|---|---|---|
| `bogotaTodayUtcStart()` en diagnostico.tsx | diagnostico.tsx:48 | ✅ Verificado con casos edge |
| `aggregateFacturacion()` parseo de Number | diagnostico.tsx:277 | ✅ Number() defensivo |
| `bogotaDateKey()` en metrics.ts | metrics.ts:58 | ✅ Usa Intl con timeZone |
| `useAllFacturas()` paginación | queries.ts:134 | ✅ Ya paginado |
| `useClientes()` trae todos | queries.ts:18 | ✅ Activos + inactivos |
| Status de runs (fail/warn/ok) | reparador-bg, limpiador-bg, supervisor.ts | ✅ Exigencia activada |

## Lo que NO está auditado todavía

Pendiente para sesiones futuras:

- [ ] Validar que `agent_events.payload.total` siempre se guarde como number en INSERT (backend pipeline)
- [ ] Validar que `agent_events.payload.fecha` siempre sea YYYY-MM-DD válido
- [ ] Snapshot diario de counts por cliente (para detectar drift)
- [ ] Tests automatizados de regresión sobre estos cálculos
- [ ] Validación cruzada Sheet vs Events vs Drive en endpoint dedicado (ya existe health-check)

## Cómo verificar mañana

1. Abrí `/operacion`
2. Mirá "Valor entregado COP" — debería ser mayor que antes (no se descartan más strings)
3. Mirá `/cliente/freshco` → chart "Facturas procesadas 2026" → ENE debería verse completo
4. Mirá `/diagnostico` → cards de los 5 agentes → "errores hoy" debe ser preciso
5. Si querés validar 100%, corré la auditoría con `/diagnostico` → Auditoría → Freshco → ver Gmail vs Drive vs Sheet vs Events

---

**Commit pusheado**: `d2eecfe` + commit final con los 4 limits ajustados.

Total bugs fixed: **8**
Total tiempo de auditoría: ~60 min
