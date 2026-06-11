# Candidatos a eliminar — análisis para limpieza del repo

> **Generado:** 2026-06-11 (sesión autónoma).
> **Estado:** SOLO LISTA. **No se borró ningún archivo.** La decisión de borrar es de Tomás.
> Este documento es el insumo para que vos decidas qué eliminar y en qué pasada.

## Cómo se verificó

- Mapa de `agentes/`, `netlify/functions/`, `netlify.toml` (raíz y admin), `scripts/`, `docs/`.
- Grep global de imports de código: `Equipo-(monitor|reparador|limpiador|supervisor|archivero)/lib` → solo aparecen **2 imports reales** en todo el repo (ver abajo).
- Revisión de `export const config = { schedule }` en cada función para distinguir crons activos de desactivados.
- Búsqueda de referencias en `apps/admin/` (panel), `docs/` (curls) y `netlify.toml`.

## Estado de los crons (scheduled functions)

| Cron | Schedule | Estado |
|---|---|---|
| `facturacion-cron` | `0 12 * * *` | ✅ ACTIVO (vivo) |
| `inspector-cron` | `0 13 * * *` | ✅ ACTIVO (vivo) |
| `archivero-cron` | `15 13 * * *` | ⚠️ ACTIVO pero dispara `archivero-background` que **NO existe** → fetch a 404 (no-op) |
| `supervisor-cron` | `45 13 * * *` | ⚠️ ACTIVO pero dispara `supervisor-background` que **NO existe** → fetch a 404 (no-op) |
| `monitor-cron` | `0 0 31 2 *` | ❌ DESACTIVADO (31-feb, fecha imposible) |
| `reparador-cron` | `0 0 31 2 *` | ❌ DESACTIVADO |
| `limpiador-cron` | `0 0 31 2 *` | ❌ DESACTIVADO |
| `onboarding-watchdog-cron` | `0 0 31 2 *` | ❌ DESACTIVADO (pausa deliberada, NO borrar — ver abajo) |

Los únicos `*-background` que existen entre estos agentes son `monitor-background` e `inspector-background`. **No existen** `archivero-background`, `supervisor-background`, `reparador-background` ni `limpiador-background`.

---

## 🟢 GRUPO 1 — Backend de agentes legacy (alta confianza)

Forman un **cluster cerrado**: los únicos imports de código son `monitor-background → Equipo-monitor` y `Equipo-archivero → Equipo-reparador + Equipo-limpiador`. Nada fuera del grupo los importa. Borrando el grupo completo no queda ningún import colgado → `tsc` y `vitest` no se afectan.

### Carpetas de agentes
| Ruta | Justificación |
|---|---|
| `agentes/Equipo-monitor/` | Renombrado → `Equipo-inspector` el 2026-05-15 (lo dice `inspector-background.mts`). Solo lo importa `monitor-background.mts`. |
| `agentes/Equipo-reparador/` | Solo lo importa `Equipo-archivero/lib/archivero.ts` (que también está muerto). Su `reparador-background` no existe. |
| `agentes/Equipo-limpiador/` | Igual: solo lo importa `archivero.ts`. Su `limpiador-background` no existe. |
| `agentes/Equipo-supervisor/` | **Nadie** importa `supervisor.ts`. Su `supervisor-cron` dispara un background inexistente. |
| `agentes/Equipo-archivero/` | **Nadie** lo importa. Wrapper que coordina reparador+limpiador. Su `archivero-cron` dispara un background inexistente. |

### Funciones Netlify
| Ruta | Justificación |
|---|---|
| `netlify/functions/monitor-cron.mts` | scheduled desactivado; reemplazado por `inspector-cron`. |
| `netlify/functions/monitor-background.mts` | solo lo dispara `monitor-cron` (desactivado). |
| `netlify/functions/reparador-cron.mts` | scheduled desactivado; su background no existe. |
| `netlify/functions/limpiador-cron.mts` | scheduled desactivado; su background no existe. |
| `netlify/functions/supervisor-cron.mts` | scheduled ACTIVO pero apunta a `supervisor-background` (inexistente) → no-op. |
| `netlify/functions/archivero-cron.mts` | scheduled ACTIVO pero apunta a `archivero-background` (inexistente) → no-op. |

**Sobre tu regla "deploy no debe romperse / nada borrado sea scheduled activo":** los 2 crons *activos* de este grupo (`supervisor-cron`, `archivero-cron`) ya están **rotos** hoy (su background fue removido); no hacen trabajo productivo. Borrarlos limpia 2 crons-zombie. Ninguna función de este grupo hace trabajo real hoy.

---

## 🟡 GRUPO 2 — Admin panel (riesgo medio; requiere editar config)

| Ruta | Nota |
|---|---|
| `apps/admin/netlify/edge-functions/admin-reparador-trigger-cliente.ts` | Edge function que dispara `reparador-background` (inexistente) → ya da 404. Excluida del `tsc` raíz. |
| `apps/admin/netlify.toml` (líneas ~32-34) | **OBLIGATORIO si se borra la edge function:** quitar el bloque `[[edge_functions]]` de `admin-reparador-trigger-cliente`. Si se borra el `.ts` sin quitar esta declaración, **el deploy del site admin se rompe**. |

**Lo que NO conviene tocar en esta pasada (refactor de UI, coordinar aparte):**
- `apps/admin/src/components/SaludArchivo.tsx:430` hace `fetch("/api/admin/reparador-trigger-cliente")` — es un botón. Si se borra la edge function, ese botón da 404 (igual que hoy). **No rompe el build** (es un fetch a string). Quitar el botón es refactor `.tsx` opcional.
- `apps/admin/src/lib/queries.ts` (`useReparadorLastRun`, `useArchiveroLastRun`, `useLatestReparadorValidations`) y `apps/admin/src/routes/clientes.tsx` (lista de agentes) referencian `'reparador'/'archivero'` **por string** para leer `agent_runs` de Supabase. **No se rompen** al borrar el backend (leen datos históricos). Limpiarlos es refactor de UI separado.

---

## 🟡 GRUPO 3 — Docs

| Ruta | Nota |
|---|---|
| `docs/PLAYBOOK-AGENTES.md` | Documenta los 4 agentes legacy (monitor/reparador/limpiador/supervisor). Quedaría desactualizado al borrarlos. Solo se menciona en `docs/AUDIT-PANEL.md` como historial (no es link funcional). |

> El resto de docs (`INCIDENTE-2026-05-14`, `RESUMEN-CORRECCIONES-2026-05-14`, `AUDITORIA-MANUAL-2026-05-15`, manuales, specs) **no se evaluaron en profundidad**: son registros históricos con valor de archivo. No los marco como obsoletos sin tu confirmación.

---

## 🔧 Hallazgo extra (no es un borrado de archivo)

`package.json` tiene 4 scripts npm rotos que apuntan a `agentes/facturacion/` (carpeta **inexistente**; la real es `agentes/Equipo-facturacion/`):
- `facturacion:procesar`, `facturacion:dry-run`, `facturacion:diagnostico`, `facturacion:setup-oauth`.

Los archivos destino **sí existen** en `agentes/Equipo-facturacion/scripts/` (`procesar-facturas.ts`, `diagnostico-facturas.ts`, `setup-oauth.mjs`). **Fix sugerido:** reemplazar `agentes/facturacion/` → `agentes/Equipo-facturacion/` en esos 4 scripts (incluye el `--env-file`). `facturacion:auditoria` ya está correcto.

---

## ⛔ NO tocar (vivos o pausados a propósito)

- `agentes/Equipo-inspector/` — vivo (`inspector-cron` activo + `inspector-background`).
- `agentes/equipo-cartera/` — proyecto Python independiente, documentado en `AGENTS.md`.
- `netlify/functions/onboarding-watchdog-cron.mts` — pausado deliberadamente (Feb 31) con instrucciones de reactivación; **no es código muerto**.
- `scripts/run-local.ts` — utilidad activa para correr handlers localmente.

---

## Orden de borrado sugerido (cuando decidas hacerlo)

1. **Grupo 1** completo (agentes + funciones) en un commit. Verificar `tsc --noEmit` + `vitest run`.
2. **Grupo 2**: borrar la edge function **y** editar `apps/admin/netlify.toml` en el mismo commit (sino rompe el deploy admin). Opcional: quitar el botón en `SaludArchivo.tsx`.
3. **Grupo 3** + fix `package.json` en un commit aparte (cambios de docs/config, sin riesgo de runtime).

**Verificación post-borrado:** `npx tsc --noEmit` (exit 0), `npx -y vitest run` (todos verdes), y confirmar que ninguna función borrada sea un scheduled activo que haga trabajo real (los 2 activos de Grupo 1 ya están rotos).
