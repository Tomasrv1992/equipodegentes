# ARRANQUE — punto de partida para retomar (equipodegentes)

> Estado real al 2026-06-12. **Corrige** la suposición de reportes anteriores de que "ya estaba deployado": **nada del trabajo nuevo está pusheado ni en producción todavía.** Empezá por acá.

## Estado actual (qué es verdad hoy)

| Cosa | Estado |
|---|---|
| 11 commits nuevos (dedup, limpieza, conciliación, tests, evals) | ✅ en local · ⛔ **SIN pushear** (`origin/main` está en `b46a3b9`, viejo) |
| Producción (deploy Netlify `equipodegentes-cron`) | corre el commit **viejo** → endpoints nuevos dan **404** |
| Migración `0018` (`facturas_registro`) en Supabase | ✅ **aplicada** en prod |
| Compute de Supabase | ✅ subido **NANO → MICRO** (salió de *Unhealthy*; era la causa de timeouts) |
| `FACTURACION_INTERNAL_SECRET` en `.env.local` | ✅ guardado en `agentes/Equipo-facturacion/.env.local` (funciona: `cliente-status` → 200) |
| Build del **admin** (`apps/admin`) | ⛔ **roto** por 3 errores `TS6133` en `Matriz.tsx` (preexistentes) |

**La clave:** todo el código está listo y verificado en local (`tsc --noEmit` exit 0, `vitest` 84 tests verdes), pero **no llegó a producción porque falta el `git push`**. Por eso los curls de la TAREA A dan 404.

## Pasos para dejar todo operativo (EN ORDEN)

### 1. Pushear
```powershell
cd c:\Users\TOMAS\Desktop\equipodegentes
git push
```
Sube los 11 commits → Netlify re-deploya. Incluye: dedup BD (0018), **limpieza de agentes legacy** (borra del deploy monitor/reparador/limpiador/supervisor/archivero y sus crons), conciliación, tests, evals, docs.

### 2. Verificar el deploy del `cron`
En Netlify (site `equipodegentes-cron`) el último deploy debe quedar **Published** (verde). Confirmá que los endpoints nuevos ya existen (debe dar **200**, no 404):
```powershell
$secret = ([regex]::Match((Get-Content 'agentes/Equipo-facturacion/.env.local' -Raw),'FACTURACION_INTERNAL_SECRET\s*=\s*([0-9a-fA-F]{16,})')).Groups[1].Value
curl.exe -s -o NUL -w "%{http_code}" -X POST "https://equipodegentes-cron.netlify.app/.netlify/functions/conciliar-facturacion" -H "x-internal-secret: $secret" -H "content-type: application/json" -d '{\"clienteSlug\":\"freshco\",\"year\":2026}'
```
> El deploy del site `admin` puede fallar por `Matriz.tsx` (paso 5). Es un site **separado**, no bloquea esto.

### 3. Rollout dedup — TAREA A (curls con guardas)
Backfill dryRun freshco → si `wouldInsert` ∈ [900,1300] correr el real → ídem dentilandia (real solo si `wouldInsert ≤ total_eventos` y `> 0`) → conciliación `format:"texto"` de freshco y dentilandia. Detalle y curls exactos en [REPORTE-NOCHE-2026-06-11.md](REPORTE-NOCHE-2026-06-11.md). No corregir discrepancias, solo reportarlas.

### 4. Evals del extractor LLM (TAREA C)
Requiere `ANTHROPIC_API_KEY` en un `.env`:
```powershell
npx tsx --env-file=<.env con la key> agentes/Equipo-facturacion/evals/run-evals.ts
```

### 5. Arreglar el build del admin
3 errores `TS6133` (declarado y nunca usado) en `apps/admin/src/components/Matriz.tsx`:
- línea 34: `import SaludOAuth` — sin usar.
- línea 96: `const ratioROI` — sin usar.
- línea 553: `function HistoricoMensual` — sin usar (decidí si la borro o la integro).

Verificar con: `cd apps/admin; npm run build` (debe terminar exit 0).

### 6. (Pendiente de diseño) Limpiar UI del admin — TAREA D
El reparador/archivero alimenta `SaludArchivo` y `ResumenSaludClientes` (componentes enteros que leen runs históricos). Limpiar eso es rediseño: reemplazar la sección "Salud del archivo" por la conciliación nueva. NO tocar el set `SYNTHETIC` de `clientes.tsx` (excluye los slugs de agentes; quitar entradas los reintroduce como clientes falsos).

## Los 11 commits locales (orden cronológico)

```
8a51a33  feat(facturacion): dedup de facturas a nivel BD (migración 0018)
5d93f5b  docs(limpieza): listado de candidatos a eliminar
c14add5  docs(sesion): reporte de sesion autonoma
a7c67fd  chore(cleanup): eliminar agentes legacy (Grupo 1)
2fc2f15  chore(cleanup): eliminar edge function admin-reparador-trigger (Grupo 2)
1a38c11  chore(cleanup): borrar PLAYBOOK-AGENTES.md + fix package.json (Grupo 3)
7393ae8  feat: conciliacion gmail-bd-sheet-drive
cde7f08  docs(sesion): actualizar reporte
c44f358  test: caracterizacion pipeline (red pre-refactor)
8db66ea  feat: evals harness extractor llm
b147909  docs: reporte sesion nocturna
```

## Para retomar con Claude en una sesión nueva (pegá esto)

> Working dir: `c:\Users\TOMAS\Desktop\equipodegentes`. Leé `docs/ARRANQUE.md` y seguimos desde el primer paso pendiente. Contexto: 11 commits locales sin pushear (dedup BD 0018, limpieza de agentes, conciliación, tests, evals); la migración 0018 ya está aplicada en Supabase; el secret está en `agentes/Equipo-facturacion/.env.local`; pero el deploy de prod es viejo (endpoints nuevos dan 404 hasta que se pushee). No pushees vos salvo que te lo pida.
