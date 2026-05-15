# Incidente 2026-05-14 — Catchup masivo generó api-quota cascade

## Resumen ejecutivo (capturado del panel admin)

**Reporte ejecutivo del día (snapshot 2026-05-15 ~01:40 UTC):**
- 2.716 errores en el procesamiento
- 18 retriggers del supervisor
- Solo 10 de 11 clientes corrieron
- Freshco crítico: 2.347 errores (86% del total), status "fail"
- 1.034 facturas nuevas procesadas, 1.339 repetidas (dedup OK), 1.397 saltadas (correcto)
- $1.88 USD en Anthropic (627 LLM calls)

**Lista de clientes con problemas (vista panel `/clientes`):**

| Cliente | Health | May 2026 | Errores 7d | Estado |
|---|---:|---:|---:|---|
| Freshco | 35/100 | 610 | 11 | 🔴 ATENCIÓN |
| Paulina Zarrabe Odontologia Integral | 40/100 | 27 | 5 | 🔴 ATENCIÓN |
| MP Patricia Mejia | 50/100 | 24 | 3 | 🔴 ATENCIÓN |
| Apilados | 80/100 | 0 | 0 | 🔴 ATENCIÓN (recién onboarded) |
| Falso Idolo | 60/100 | 0 | 0 | 🔴 ATENCIÓN (cliente fantasma) |
| Dentilandia | 65/100 | 65 | 0 | 🟡 CAYÓ (-60% vs mes ant) |
| Mateoramirez | 65/100 | 18 | 0 | 🟡 CAYÓ (-58%) |
| JAVA | 65/100 | 8 | 0 | 🟡 CAYÓ (-62%) |
| tomas | 65/100 | 58 | 0 | 🟢 OK (-13%) |
| tomas92 | 65/100 | 40 | 0 | 🟢 OK (-34%) |
| Andres | 70/100 | 18 | 1 | 🟢 OK (-49%) |
| Rafael Chejne | — | 0 | 0 | INACTIVO |

## Causa raíz

1. **Catchup masivo Freshco** disparó 3 runs concurrentes con `force=true` sin filtro `monthFilter` efectivo (el filter NO se guardó en payload del run, pero parece haberse aplicado parcialmente).

2. **Anthropic Tier 1 = 50 RPM**. Cada run usa hasta 40 RPM (token bucket configurado en commit `f0c0bc2`). Pero el bucket es **per-process** — 3 runs paralelos × 40 RPM = 120 RPM solicitados vs 50 RPM permitidos → cascada de 429s.

3. **Resultado:** 2.246+ errores `api-quota` en runs de Freshco (1176 + 1070 según queries de payload).

4. **Bug colateral:** `monthFilter` no se guarda en `payload` de `agent_runs` → diagnóstico complejo, las queries por `payload->>'monthFilter'` retornan 0 rows.

5. **Andres**: OAuth `invalid_grant` (no relacionado al catchup, problema preexistente). NO procesó nada → su health 70 está sobrevalorado (debería ser CRÍTICO).

## Errores pendientes de corregir

- [ ] **Freshco api-quota**: re-disparar UNO POR UNO con stagger >5min entre meses (no concurrente)
- [ ] **Andres invalid_grant**: enviar link de re-onboarding al cliente para reconectar OAuth
- [ ] **Falso Idolo**: cliente fantasma activo sin credentials → decidir si deshabilitar o completar onboarding
- [ ] **Dentilandia / Mateoramirez / JAVA "CAYÓ"**: investigar si los emails no llegan o el cron diario tiene problema
- [ ] **Paulina Zarrabe / MP Patricia (errores 7d)**: investigar root cause de los 5 y 3 errores recurrentes
- [ ] **monthFilter en payload**: agregar al `recordRunEnd` para que las queries de diagnóstico funcionen sin tener que mirar `triggered_by` o `error_message`
- [ ] **Token bucket global (no per-process)**: usar Redis o equivalente para que múltiples runs concurrentes compartan el límite Anthropic
- [ ] **Supervisor decision logic**: re-evaluar si el supervisor debe ser el ÚNICO que dispara retriggers (eliminar dispatches manuales por curl y el watchdog cron separado) — alineado con decisión Tomás 2026-05-14 sobre arquitectura

## Resultado real del catchup (post-cleanup zombies)

Cifras reales (queries con paginación):

| Mes | Pre-catchup | Post-catchup | Delta | Status |
|---|---:|---:|---:|---|
| Enero | 350 | 350 | +0 | run murió early por api-quota |
| Febrero | 283 | **439** | **+156** | recuperado parcial |
| Marzo | 253 | **338** | **+85** | recuperado parcial |
| Abril | 428 | 428 | +0 | sin cambio (no estaba en catchup) |
| Mayo | 610 | 610 | +0 | sin cambio |
| **Total** | **1924** | **2165** | **+241** | catchup parcialmente exitoso |

**Hipótesis nueva sobre Freshco ene/feb/mar:**
El patrón de crecimiento gradual (350 → 439 → 338 → 428 → 610) sugiere que Freshco
**arrancó la relación con el proveedor único (Frutas y Legumbres SAS) gradualmente
entre marzo-mayo**. Las facturas "faltantes" en enero quizás NO EXISTEN en Gmail —
los 350 podrían ser TODAS las facturas reales de ese mes (otros proveedores que ya
no se ven en mayo). Validar con query: "top proveedores de freshco en enero vs mayo".

## Acciones ejecutadas esta sesión

- ✅ 6 zombies de Freshco cerrados manualmente vía REST (running >10min, errored
  con "Zombie cleanup post-incidente catchup: api-quota Anthropic")
- ✅ Andres `google_oauth_status` marcado como `expired` en `client_credentials`
- ✅ Documentado este incidente

## Bug detectado — marcador OAuth=expired demasiado agresivo

**Síntoma:** Andres mostraba "OAuth expirado · reconectar" en panel, pero sus 11
runs anteriores (desde 8 al 13 may) eran TODOS `ok`. Solo el run del 14 may falló
con `invalid_grant` — probable causa transitoria (token cache Google, race
condition durante refresh, o rate limit OAuth endpoint).

**Causa del falso positivo:** el código en `facturacion-background.mts` (commit
`098dbc4`) marca `google_oauth_status='expired'` automáticamente al PRIMER
fallo de preflight con `check='oauth'`. Demasiado agresivo.

**Fix necesario (próxima sesión):**
1. Marcar `expired` solo después de N (ej: 3) fallos consecutivos
2. O NO sobrescribir el status si el último `agent_run` previo fue `ok`
3. Considerar diferenciar `expired` vs `transient_failure` para no asustar al admin

**Action ejecutada:** revertido manualmente a `connected` vía REST PATCH.

## Acciones pendientes (próxima sesión)

1. **Fix anti-falso-positivo OAuth** (ver bug arriba)
2. **Investigar si quedan facturas en Gmail de Freshco ene** — query Gmail-side con `force=true` y `monthFilter=1` UNA SOLA VEZ (no concurrente con otros runs)
3. **Verificar patrón proveedores Freshco** ene vs mayo para confirmar hipótesis de "negocio cambió"
4. **Investigar Dentilandia/Mateoramirez/JAVA "CAYÓ"** — pueden ser patrones reales (mes en curso, menos facturas a esta fecha) o problema técnico
5. **Investigar fails recurrentes** de Paulina (5 errores 7d) y MP Patricia (3 errores 7d)

## Lecciones aprendidas

1. **Nunca disparar múltiples meses del mismo cliente en paralelo** — saturan Anthropic.
2. **Stagger 30s insuficiente para Tier 1** — necesita 5-10 min entre meses del mismo cliente.
3. **El supervisor es la fuente correcta de retriggers** — los dispatches manuales rompen el anti-loop.
4. **OAuth expired silencioso** sigue siendo un problema — el preflight (commit `098dbc4`) ayuda pero el cron diario lo detecta y marca, sin que Tomás reciba alerta urgente.
