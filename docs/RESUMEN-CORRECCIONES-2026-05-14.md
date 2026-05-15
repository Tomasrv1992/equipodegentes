# Dashboard Sesión — 2026-05-14

Resumen ejecutivo del trabajo overnight + correcciones del día.

Branch: `feat/admin-panel` → merged a `main` (`d84a5ef`).
Deploy: automático en Netlify (cron + admin sites).

---

## 1. ESTADO INICIAL · qué había antes

### Cobertura por cliente × mes (snapshot pre-correcciones)

| Cliente | Ene | Feb | Mar | Abr | May | Total | Diagnóstico |
|---|---:|---:|---:|---:|---:|---:|---|
| freshco | 350 | 283 | 253 | 428 | 610 | **1924** | 🔴 ene/feb/mar incompletos (1 proveedor único factura ~60/día × 22 días hábiles → debería tener ~1300/mes) |
| dentilandia | 60 | 175 | 161 | 162 | 65 | 623 | 🟡 enero bajo (3× menos que feb-abr) |
| mp-patricia-mejia | 33 | 54 | 80 | 55 | 24 | 246 | 🟢 normal |
| tomas | 14 | 29 | 45 | 67 | 58 | 213 | 🟢 normal |
| tomas92 | 46 | 25 | 31 | 61 | 40 | 203 | 🟢 normal |
| paulina-zarrabe | 54 | 28 | 40 | 17 | 27 | 166 | 🟢 normal (negocio chico) |
| andres | 40 | 10 | 39 | 35 | 18 | 142 | 🟡 febrero bajo (4× menos) |
| mateoramirez | 18 | 29 | 32 | 43 | 18 | 140 | 🟢 normal |
| java | 11 | 8 | 12 | 21 | 8 | 60 | 🟢 normal |
| apilados | — | — | — | — | — | — | 🟢 recién onboarded (13-may) |
| **falso-idolo** | — | — | — | — | — | — | ⚠️ cliente fantasma · activo=true sin credentials |
| rafael-chejne | — | — | — | — | — | — | inactivo, OK |

### Bugs detectados

1. **`first_run_done` atascado en Freshco** — UI mostraba "Onboarding en progreso · LIVE" aunque ya había procesado 1700+ facturas. Bug: el código viejo solo marcaba el flag si `errores.length === 0`. Cualquier error histórico lo dejaba "stuck" indefinidamente.

2. **Multi-pass UI undercount** — Componente mostraba FEB=120 / MAR=0 / ABR=0 mientras el histórico mostraba FEB=283 / MAR=253 / ABR=214. Bug: query `eventsByMonth` sin paginación → Supabase corta a 1000 rows, Freshco tiene 1710.

3. **"100 errores" del run WARN (31% error rate)** — Alarmante a primera vista. Investigación: los 100 errores son **PDFs encriptados de bancos** (Bancolombia, Itaú, tarjetas Visa/Mastercard) que entran al Gmail del cliente. El query amplio los captura, pdf-parse falla con "No password given", se reportan como error. **No son facturas reales fallando.** Bug de clasificación.

4. **Zombies de Freshco** — 4 runs marcados `RUNNING` que ya habían terminado pero el monitor todavía no los había cerrado (espera 30 min).

5. **Reparador + Limpiador duplicaban trabajo LLM** — Ambos descargaban PDFs huérfanos, los pasaban por pdf-parse + Anthropic. Costo LLM 2× por huérfano.

6. **Anti-loop supervisor mal contado** — `contarRetriggersHoy(slug)` sin filtro por agente → un cliente con 3 problemas distintos saturaba el cap en una sola pasada, bloqueado el resto del día.

7. **Limpiador concurrency sin timeout** — Un PDF colgado podía bloquear los 5 workers → Netlify function timeout (15 min) sin reportar.

8. **Limpiador apendaba duplicados** — Sin dedup numero+NIT antes de Sheet append.

9. **OAuth/Drive/Sheet/Gmail fallaban a mitad del pipeline** — sin pre-flight check, problemas de credenciales se detectaban tarde con contexto pobre.

---

## 2. TRABAJO REALIZADO

### Commits en `feat/admin-panel` (15 totales, merged a main)

| Commit | Categoría | Qué hace |
|---|---|---|
| `4159d35` | P0 onboarding | Fan-out skip meses futuros + orden desc + first_run_done marcado al INICIO + idempotencia folder/sheet en OAuth callback (anti-race) |
| `f167728` | UX onboarding | Email per-mes "Listo {mes}: N facturas" + edge function `/api/onboarding/estimate` + card "Encontramos ~287 facturas · ~22 min" en wizard |
| `64ed273` | Panel admin | Sección "En onboarding" en `/operacion` con chips por mes (verde/rojo/azul/gris), botón Re-disparar mes X, links Sheet/Drive · edge function `admin-onboarding-rerun-month` |
| `74f94ee` | Robustez | Watchdog cron `*/30 * * * *` re-dispatcha automáticamente meses fallidos (cap 3 por cliente/run) |
| `f0c0bc2` | Escalabilidad | Token bucket Anthropic 40 RPM proactivo en `llm-rate-limiter.ts` integrado en `llm-extractor.ts` |
| `098dbc4` | Confiabilidad | Pre-flight (oauth/drive/sheet/gmail) en 2-4s antes de cada run · si falla aborta limpio + email a Tomás con hint accionable + marca oauth=expired |
| `ac43937` | DB schema | Migration 0015: `first_run_mode` column en client_credentials (rapido/completo) |
| `90e1cf6` | Panel admin | Botón "Validar" on-demand en cada card de cliente · endpoint `/api/admin/client-preflight` muestra 2×2 con resultados color-coded |
| `d12a450` | Agentes refactor | (a) Reparador Etapa 4.B LLM deprecated (env flag para reactivar) — limpiador único dueño · (b) Supervisor anti-loop por agente-destino separado, no global |
| `f54ef45` | Limpiador hardening | `HUERFANO_TIMEOUT_MS=60s` con Promise.race · dedup numero+NIT antes de Sheet append |
| `7e25a6e` | Docs | AUDIT-PANEL.md morning brief completo |
| `d899153` | Bug fixes | Paginación events-por-mes en componente OnboardingProgress · watchdog auto-marca `first_run_done=true` en clientes "stuck" como Freshco (heurística: ≥80% meses cubiertos O ≥200 facturas AND onboarded hace >6h) |
| `1206687` | Pipeline classification | PDFs encriptados (No password given) reclasificados como `saltadas`, no `errores` · `sample_errors[]` + `error_pattern_breakdown` en payload (diagnóstico vía SQL, sin Netlify logs) |
| `e449da8` | Tooling | Script bash `catchup-clientes-rezagados.sh` + SQL `catchup-validar.sql` |
| `22a7096` | Tooling | Versión PowerShell `catchup-clientes-rezagados.ps1` (Windows nativo) |
| `d84a5ef` | Merge | Merge `feat/admin-panel` → `main` |

### Acciones operativas ejecutadas

| Acción | Estado |
|---|---|
| Migration 0015 (`first_run_mode`) aplicada en Supabase | ✅ |
| Cleanup 3 runs zombie de Freshco (`monthFilter=null`, running > 15min) | ✅ |
| Merge a `main` + push origin | ✅ |
| Netlify deploy automático sites cron + admin | ✅ (verificado vía HTTP 202 del catchup) |
| **5 dispatches catchup** (los que cierran los gaps) | ✅ todos HTTP 202 |

### Catchup dispatches (en ejecución background)

| Hora | Cliente | monthFilter | Status |
|---|---|---:|---|
| 20:03:20 | freshco | 3 (marzo) | dispatched |
| 20:04:10 | freshco | 1 (enero) | dispatched |
| 20:04:40 | freshco | 2 (febrero) | dispatched |
| 20:05:11 | dentilandia | 1 (enero) | dispatched |
| 20:05:41 | andres | 2 (febrero) | dispatched |

Flags: `force=true, silent=true, notifyMonthComplete=true, skipSheetSetup=true, skipPreflight=true`

---

## 3. ESTADO FINAL · qué queda

### Cobertura proyectada post-catchup (pendiente validación SQL)

| Cliente | Ene | Feb | Mar | Abr | May | Total proy. | Cambio |
|---|---:|---:|---:|---:|---:|---:|---|
| freshco | ~1300 | ~1100 | ~1300 | 428 | 610 | ~4738 | **+2814** |
| dentilandia | ~170 | 175 | 161 | 162 | 65 | ~733 | +110 |
| andres | 40 | ~40 | 39 | 35 | 18 | ~172 | +30 |

(Proyección basada en patrón del proveedor único de Freshco ~60/día × ~22 días hábiles, y patrones promedios del resto.)

### Mejoras técnicas en producción

✅ **Reducción de errores**
- Pre-flight detecta credenciales rotas en 2-4s con email accionable
- PDFs encriptados clasificados correctamente como `saltadas` (no `errores`)
- Token bucket evita 429s de Anthropic
- Limpiador timeout 60s evita workers colgados
- Dedup numero+NIT antes de Sheet append

✅ **Visibilidad admin**
- Sección "En onboarding" en `/operacion` con chips por mes + botón Re-disparar
- Botón "Validar" on-demand muestra estado credenciales sin esperar al próximo cron
- `sample_errors` y `error_pattern_breakdown` en payload → diagnóstico vía SQL directo

✅ **Robustez automática**
- Watchdog cron 30-min auto-retry meses fallidos
- Watchdog auto-marca `first_run_done=true` en clientes "stuck"
- Anti-loop supervisor por agente-destino separado
- Onboarding callback idempotente (no duplica folder/sheet en doble-click)

✅ **UX cliente**
- Email per-mes durante backfill ("Listo enero: 350 facturas")
- Estimación previa en wizard ("encontramos ~287 facturas · ~22 min")
- First_run_done marcado ANTES del dispatch (no doble-proceso si cron corre durante backfill)

### Pendiente validación (próximo paso inmediato · ~15-20 min)

Esperar que los 5 catchups terminen de procesar (cada uno máx 15 min) y correr `scripts/catchup-validar.sql`:

1. Status de los runs (procesadas/errores/duracion por cliente·mes)
2. Cobertura nueva vs snapshot pre-catchup
3. `error_pattern_breakdown` confirmar que PDFs encriptados van a saltadas
4. Patrón proveedor único Freshco (¿están todos los meses cubiertos?)

### Pendientes diferidos · próxima sesión

| Item | Por qué quedó | Acción cuando se haga |
|---|---|---|
| **Fusionar reparador + limpiador** | Refactor grande, mitigado por env flag `REPARADOR_LLM_HUERFANOS=false` (commit `d12a450`) | Eliminar reparador, mover lógica útil a limpiador renombrado |
| **Renombrar Equipo-monitor → Equipo-inspector** | Acordado pero requiere rename folder + DB migration + update referencias | Search/replace masivo + migration que cambia `agente_id='monitor'` → `agente_id='inspector'` |
| **Wizard "rápido vs completo"** | Migration y type listos (`ac43937`), falta UI radio + backend skip-fanout-if-rapido | Edit `StepFiscalData` en `onboarding.tsx` + read flag en `facturacion-background.mts` |
| **Sample preview en wizard** | Similar al anterior, UX dedicado | Edge function que procesa 5 facturas test antes del dispatch real |
| **Anti-spike global** | LOW prio con 11 clientes, sí cuando lleguemos a 20+ | Cola Redis o similar para limitar concurrencia |
| **Re-audit post-retrigger** | Infra de delayed checks (BullMQ/Inngest) | Considerar |
| **Cliente falso-idolo huérfano** | Decisión administrativa pendiente | Verificar si onboarding abandonado → marcar `activo=false` |

### Higiene de seguridad

⚠️ **Rotar `FACTURACION_INTERNAL_SECRET`** en Netlify. El valor fue compartido en esta sesión para ejecutar los catchups. Pasos:
1. Netlify → equipodegentes-cron → Site configuration → Environment variables
2. `FACTURACION_INTERNAL_SECRET` → ⋯ → Edit → cambiar a nuevo valor random
3. Save + Trigger redeploy

Después de eso, cualquier catchup futuro va vía panel admin con JWT (sin necesidad de secret).

---

## Resumen de una línea

**De 9 clientes activos, 3 tenían meses incompletos. 15 commits robustecen pipeline (preflight, watchdog, fan-out optimizado, error classification). Catchup masivo en curso — proyección: +2954 facturas recuperadas. Panel admin gana visibilidad de "En onboarding" + botones de re-disparo y validación on-demand. Próxima sesión: fusionar reparador+limpiador y renombrar monitor→inspector.**
