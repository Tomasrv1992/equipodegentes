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

---

# Sesión overnight — 2026-05-13 → 2026-05-14

Segunda ola: extender la auditoría de panel a **reducir errores en el
pipeline diario y en el onboarding de cliente nuevo**, además de revisar
la chain de agentes (monitor/reparador/limpiador/supervisor) para eliminar
trabajo duplicado y robustecer.

Branch: `feat/admin-panel`. **NO pusheado** todavía — esperando OK de Tomás.

## Resumen de commits

| Commit | Bloque | Qué hace |
|---|---|---|
| `4159d35` | P0 onboarding | Auto-fan-out skip meses futuros + orden desc + first_run_done ANTES del dispatch + idempotencia folder/sheet en OAuth callback |
| `f167728` | Email per-mes + estimate | Email "Listo {mes}: N facturas" cuando termina cada mes del backfill · edge function `/api/onboarding/estimate` + card en wizard StepDone con "encontramos ~287 facturas · ~22 min" |
| `64ed273` | Onboarding panel admin | Sección "En onboarding" en `/operacion` con chip por mes (verde/rojo/azul/gris), botón Re-disparar mes X, links Sheet/Drive · edge function `admin-onboarding-rerun-month` |
| `74f94ee` | Watchdog cron | `onboarding-watchdog-cron.mts` schedule `*/30 * * * *` — detecta meses sin agent_events y re-dispatcha (cap 3 por cliente/run) |
| `f0c0bc2` | Token bucket Anthropic | `shared/agents-runtime/src/llm-rate-limiter.ts` con bucket 40 RPM, integrado en llm-extractor para evitar 429s |
| `098dbc4` | Pre-flight backend | `shared/agents-runtime/src/preflight.ts` chequea oauth/drive/sheet/gmail en 2-4s ANTES del run · si falla: agent_run status=fail con hint accionable, email a Tomás, no toca Sheet/Drive · marca oauth=expired si invalid_grant · dispatches del fan-out pasan `skipPreflight: true` |
| `ac43937` | Migration 0015 | `first_run_mode` column en client_credentials (partial: solo SQL + type, falta wirear wizard UI) |
| `90e1cf6` | Pre-flight UI | Botón "Validar" on-demand en cada card de OnboardingEnCurso → llama `/api/admin/client-preflight` y muestra grid 2x2 con resultados color-coded |
| `d12a450` | Agentes refactor | (a) Reparador Etapa 4.B LLM deprecado por default (REPARADOR_LLM_HUERFANOS=true para reactivar) — limpiador es dueño · (b) Supervisor anti-loop por agente-destino, no global (un cliente con 3 problemas distintos ya no satura el cap en una pasada) |
| `f54ef45` | Limpiador hardening | (a) HUERFANO_TIMEOUT_MS=60s — un PDF colgado ya no bloquea los 5 workers · (b) Dedup numero+NIT antes de Sheet append (no duplica filas si re-corre) |

## Bugs / problemas reducidos

### Onboarding cliente nuevo

| Problema antes | Fix | Commit |
|---|---|---|
| Si OAuth callback corre 2x (doble-click, refresh), creaba 2 carpetas Drive | Idempotencia: busca por nombre antes de crear, consolida duplicados, trashea extras | `4159d35` |
| Auto-fan-out disparaba 12 meses fijos (enero..diciembre), 7 vacíos | Solo dispara 1..currentMonth | `4159d35` |
| Procesaba enero primero — cliente esperaba 15 min para ver mayo en dashboard | Orden descendente: mes actual primero | `4159d35` |
| `first_run_done=true` se marcaba al final de Promise.all → cron diario podía re-disparar fan-out mientras el original aún corría | Marcado ANTES del dispatch | `4159d35` |
| Cliente esperaba 15+ min al "welcome email" sin saber si algo se procesó | Email per-mes "Listo mayo: 87 facturas" al terminar cada mes | `f167728` |
| Cliente veía dashboard vacío durante backfill, pensaba que estaba roto | Card "Encontramos ~287 facturas en tu Gmail · ~22 min" en StepDone | `f167728` |
| Si un mes timeouteaba/fallaba, quedaba el hueco hasta que Tomás lo viera | Watchdog cron cada 30 min detecta y re-dispatcha (cap 3) | `74f94ee` |

### Procesamiento diario

| Problema antes | Fix | Commit |
|---|---|---|
| OAuth expirado / Drive borrado / Sheet trashed: error a mitad del pipeline con contexto pobre | Pre-flight check antes del run → aborta limpio en 2-4s, email a Tomás con hint, marca oauth=expired | `098dbc4` |
| 429 de Anthropic durante fan-out con muchos clientes paralelos | Token bucket 40 RPM proactivo (default) | `f0c0bc2` |
| Reparador y limpiador hacían LLM 2× sobre los mismos huérfanos | Reparador deprecado por default, limpiador único dueño de recuperación | `d12a450` |
| Cliente con 3 problemas distintos saturaba el contador anti-loop en una pasada → bloqueado el resto del día | Anti-loop por agente-destino separado | `d12a450` |
| PDF gigante o LLM colgado bloqueaba los 5 workers del limpiador → timeout de Netlify (15min) | Promise.race con timeout 60s por huérfano | `f54ef45` |
| Limpiador re-corriendo apendaba filas duplicadas al Sheet | Dedup numero+NIT antes de append | `f54ef45` |

### Visibilidad / control admin

| Antes | Después |
|---|---|
| Para ver salud onboarding había que entrar a cada cliente uno por uno | Sección "En onboarding" en `/operacion` con chips por mes, ETA, % completado, botón Re-disparar |
| Para diagnosticar OAuth había que esperar al próximo cron y leer logs | Botón "Validar" on-demand → grid 2x2 con resultados color-coded en segundos |
| El watchdog corre en background sin visibility | Cron `*/30 * * * *` loggea reporte por cliente: `{cliente, redispatched: [...], skipped: [...]}` |

## Cosas que requieren acción tuya (Tomás)

### 1. Migration 0015 — requiere apply en Supabase
```sql
-- En Supabase SQL Editor, correr:
\i docs/superpowers/migrations/0015_first_run_mode.sql
```
**Sin esto**, la columna `first_run_mode` no existe y el código sigue funcionando (queda undefined → asumimos 'completo'). Pero el wizard UI para elegir rápido/completo todavía no está hecho — solo migration + type. Falta wirear.

### 2. Env vars nuevas (opcionales, con defaults sanos)
```
# Anthropic rate limit (default 40 RPM). Subir si tenés tier 2+.
ANTHROPIC_RATE_LIMIT_PER_MIN=40

# Reactivar LLM huérfanos en reparador. Default: NO.
# Solo set si querés volver al comportamiento viejo (limpiador no es suficiente).
REPARADOR_LLM_HUERFANOS=false
```

### 3. Push a remote — esperando tu OK
```bash
git push origin feat/admin-panel
```
Hay 10 commits nuevos desde `b86743e`. NO los pusheé porque el plan explícitamente decía esperar tu aprobación.

### 4. Deploy a Netlify
Los cambios afectan tanto el sitio principal (`equipodegentes-cron`) como el panel admin (`equipodegentes-admin`). Ambos necesitan rebuild + deploy:
- Sitio principal: nuevos cron `onboarding-watchdog-cron` + nuevos flags `notifyMonthComplete`, `skipPreflight`
- Sitio admin: nuevas edge functions `onboarding-estimate`, `admin-onboarding-rerun-month`, `admin-client-preflight`

### 5. Smoke test manual recomendado
1. Abrí `/operacion` en panel admin → verificá que **OnboardingEnCurso** muestra clientes en first_run (probable: Operatto, si lo activaste como cliente)
2. Click "Validar" en algún cliente → debería mostrar grid 2×2 con todos los checks ✓
3. Si hay algún cliente con mes "estancado", probá el botón "Re-disparar mes" — debería disparar el background y volver con ✓
4. Esperá 30 min y mirá Netlify Functions logs → `onboarding-watchdog-cron` debería tener corrido al menos 1 vez

## Lo que queda pendiente (no hecho en esta sesión)

| Item | Por qué quedó | Cuándo |
|---|---|---|
| Wizard UI radio "rápido vs completo" + persistir first_run_mode + skip fan-out si rapido | Bigger UI + backend change, otros items tenían más impacto en error reduction | Próxima sesión |
| Sample preview "5 facturas" en wizard antes de procesar 1000 | Similar al anterior, requiere UX dedicado | Próxima sesión |
| Anti-spike global (cola si 2+ clientes en first_run) | LOW priority hoy con 4 clientes, sí escala a 20+ | Cuando lleguemos a 10+ clientes |
| Re-audit post-retrigger en supervisor | Requiere infra de delayed checks (BullMQ / Inngest / poll en supervisor mismo) | Considerar |
| Eliminar/fusionar reparador completamente — dejar limpiador único | Refactor más grande. Hoy mitigamos con el flag REPARADOR_LLM_HUERFANOS. | Cuando confirmes que limpiador solo es suficiente en 2-3 semanas de prod |
| Robustez monitor: cachear cost calculation, mejor manejo de Stage 2 (Gmail/Drive coincidence) | Identificado por audit pero impacto menor | Próxima sesión |
| Tests automatizados sobre preflight + watchdog + limpiador timeout | No hay infra de tests todavía | Si hacemos algún incidente serio |

---

**Commits**: 10 nuevos en `feat/admin-panel`.
**Branch state**: limpia, todos los commits con mensaje descriptivo.
**Push**: pendiente tu OK explícito.

---

# Sesión overnight — 2026-05-14 → 2026-05-15 (parte 2)

Continuación de la sesión anterior. Se ejecutaron 4 bloques de trabajo:
**A.** Fusión reparador + limpiador → archivero
**B.** Rename monitor → inspector
**C.** Bug fixes (contexto en payload + classifier)
**D.** Performance (code splitting, cache, OAuth stagger)
**E.** Playbook de agentes (documentación completa)

## Commits adicionales (post-merge anterior)

| Commit | Categoría | Qué hace |
|---|---|---|
| `27cce63` | Salud Archivo | Componente SaludArchivo + ResumenSaludClientes + edge function reparador-trigger-cliente |
| `155e004` | Reliability | Anti-falso-positivo OAuth (requiere PATRÓN antes de marcar expired) |
| `3126b69` | Reparador | clienteSlugFilter para re-validar 1 cliente sin esperar al cron global |
| `1206687` | Pipeline | Reclasificar PDFs encriptados como `saltadas`, agregar sample_errors[] al payload |
| `382d54d` | Refactor agentes | **Equipo-archivero coordinador** (reparador + limpiador en 1 cron) |
| `68b0283` | Refactor agentes | **Rename Equipo-monitor → Equipo-inspector** (anti-confusión con supervisor) |
| `9d56f13` | Observability | monthFilter/customerId/window en payload + classifier 20+ patterns |
| `21538ff` | Performance | Code splitting por route (bundle 574KB → 454KB, -21%) |
| `6e93a1f` | OAuth fix | **URGENTE**: stagger 800ms en cron + retry preflight (fix 3 emails falsos) |
| `82ab729` | Docs+Perf | PLAYBOOK-AGENTES.md (400+ líneas) + cache 5min en queries pesadas |

## Lo más importante de esta sesión

### Incidente 2026-05-15: emails OAuth falsos

Tomás recibió 3 emails "Preflight oauth falló — andres / tomas92 / mateoramirez" a las **12:06:30 UTC EXACTAS** los 3. Investigación reveló:
- Ninguno había revocado OAuth
- Sus runs previos del 13/14 may estaban OK
- Causa: el cron `facturacion-cron` dispatchaba con `Promise.allSettled` 11 clientes simultáneos al MISMO `client_id` OAuth de Google → rate limit transitorio del endpoint OAuth

**Fix (commit `6e93a1f`):**
- `facturacion-cron`: ahora dispatcha con stagger 800ms entre clientes (total ~9s para 11)
- `preflight.ts`: retry 1 vez con backoff 1.5-2s al primer `invalid_grant`
- Combinado: 0 emails falsos esperados mientras los clientes realmente conectados

Ya mergeado a main `babf40d` — el cron del 16-may ya usa el nuevo código.

### Refactor de agentes (anti-confusión + sin duplicación)

**Antes:** 4 agentes admin (monitor 8:00, reparador 8:15, limpiador 8:30, supervisor 8:45). Monitor y supervisor sonaban casi igual. Reparador y limpiador procesaban los mismos huérfanos con LLM, duplicando costo Anthropic.

**Ahora:** 3 agentes admin (inspector 8:00, archivero 8:15, supervisor 8:45). Inspector es claramente pasivo (observa). Archivero coordina reparador+limpiador internamente — un solo `agent_run` con `agente_id='archivero'`.

**Rollback disponible:** los crons viejos de monitor/reparador/limpiador siguen presentes con schedule `0 0 31 2 *` (31-feb, nunca corre). Revertir es cambiar 3 schedules.

### Performance

- **Code splitting** (`21538ff`): initial bundle del panel admin bajó de 574KB → 454KB (-21%), 8 chunks lazy por route.
- **Cache 5min** (`82ab729`): `useAllFacturas`, `useFacturasByCliente`, `useFacturasByAgente` ahora cachean 5min en lugar de 1min. Estos queries paginan hasta 50k events y eran el cuello de botella de navegación.
- **gcTime 30min**: si Tomás navega entre routes y vuelve, no re-fetch.

### Documentación

`docs/PLAYBOOK-AGENTES.md` (nuevo, 400+ líneas):
- Arquitectura actual de los 4 agentes + nombres antes/después del rename
- Flujo del día completo
- 8 escenarios de fallo con diagnóstico SQL específico + acción concreta:
  1. Email OAuth falso (rate limit Google)
  2. Muchos errores (interpretación error_pattern_breakdown)
  3. Discrepancias 5-fuentes
  4. Cliente no corrió
  5. Zombies persistentes
  6. PDFs huérfanos sin fila Sheet
  7. Archivero falló
  8. Supervisor con muchos retriggers
- Acciones manuales: re-disparar cliente, re-procesar mes, revertir oauth
- Métricas saludables esperadas
- Histórico de incidentes con commits

## Acciones operativas ejecutadas overnight

- ✅ 6 zombies de Freshco cerrados manualmente (post incidente catchup)
- ✅ Andres `oauth_status='connected'` revertido (era falso positivo)
- ✅ Cliente fantasma `falso-idolo` confirmado (onboarding incompleto, deshabilitar manualmente cuando tiempo)
- ✅ Merge `feat/admin-panel` → `main` `babf40d` (Netlify deploya antes del cron de mañana)

## Lo que queda pendiente para próximas sesiones

| Item | Razón | Prioridad |
|---|---|---|
| Eliminar definitivamente `Equipo-monitor` + `Equipo-reparador` + `Equipo-limpiador` | Confirmar 1 semana en prod que inspector+archivero funcionan, después borrar | Media |
| Limpiador acepte `clienteSlugFilter` | Hoy el archivero pasa filter al reparador pero limpiador siempre corre global | Baja |
| Wizard "rápido vs completo" (modo onboarding 30d vs año) | Migration + type ya listos (commit `ac43937`), falta UI radio + backend skip-fanout-if-rapido | Media |
| Tests automatizados | Si hacemos otro incidente serio | Baja |
| Anti-spike global (cola si 2+ clientes en first_run) | LOW prio con 11 clientes | Baja |
| Migration DB que mueva `agente_id='monitor'` → 'inspector', `'reparador'/'limpiador'` → 'archivero' | Histórico queda como está, runs nuevos usan nombres nuevos | Baja |

---

**Total commits sesión overnight (parte 1 + parte 2)**: 20+ en `feat/admin-panel`.
**Branch state**: mergeada a main, todo deployado a Netlify.
**Push**: ✅ todo en `origin/main` y `origin/feat/admin-panel`.
