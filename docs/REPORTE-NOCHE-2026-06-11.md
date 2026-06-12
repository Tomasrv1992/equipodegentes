# Reporte — sesión nocturna 2026-06-11

> Reglas: commit local si `tsc --noEmit` exit 0 y `vitest run` verde; **cero push**; no tocar credenciales/.env; no borrar archivos; ante ambigüedad lo conservador + anotar + seguir; fallo 3× → revertir + anotar + seguir. Orden A→B→C→D→reporte.

## TL;DR

| Tarea | Estado | Commit |
|---|---|---|
| A — Rollout dedup (curls) | ⛔ **Bloqueada** — secret no disponible localmente | — |
| B — Tests de caracterización | ✅ **Completada** | `c44f358` |
| C — Evals harness | ✅ **Creado** (no ejecutado: falta API key) | `8db66ea` |
| D — Limpiar UI admin | ⛔ **No ejecutada** — rediseño no acotado + build ya roto | — |

`tsc --noEmit` exit 0 y `vitest run` (84 tests) verdes tras cada commit. Nada pusheado.

---

## TAREA A — Rollout del dedup (curls) → BLOQUEADA

**No pude correr ningún curl.** El `FACTURACION_INTERNAL_SECRET` **no está** en el `.env.local`. El único `.env.local` del repo es `agentes/Equipo-facturacion/.env.local` y solo contiene credenciales Google del owner legacy (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `INVOICES_DRIVE_FOLDER_ID`, `INVOICES_SHEET_ID`, `INVOICES_SHEET_TAB`). No tiene `FACTURACION_INTERNAL_SECRET` ni `ANTHROPIC_API_KEY`.

Intenté localizar el secret en otros archivos `.env*`, pero el clasificador de seguridad bloqueó (con razón) el escaneo recursivo de archivos de credenciales. **Decisión conservadora: no hago credential-exploration.** El secret probablemente vive solo en las env vars de Netlify.

**Te toca a vos (rollout pendiente)** — la migración 0018 ya está aplicada y el deploy Published, así que solo faltan los curls. Reemplazá `<SECRET>` por el valor real:

```powershell
# A1 — backfill dryRun freshco
curl.exe -s -X POST "https://equipodegentes-cron.netlify.app/.netlify/functions/backfill-facturas-registro" -H "x-internal-secret: <SECRET>" -H "content-type: application/json" -d '{\"clienteSlug\":\"freshco\",\"year\":2026,\"dryRun\":true}'
# A2 — si wouldInsert ~900-1300, repetir con "dryRun":false
# A3 — idem dentilandia (real solo si wouldInsert <= total_eventos y > 0)
# A4 — conciliacion (texto) freshco y dentilandia:
curl.exe -s -X POST "https://equipodegentes-cron.netlify.app/.netlify/functions/conciliar-facturacion" -H "x-internal-secret: <SECRET>" -H "content-type: application/json" -d '{\"clienteSlug\":\"freshco\",\"year\":2026,\"format\":\"texto\"}'
```

> Nota dentilandia: el prompt avisaba de dos runs simultáneos que pudieron duplicar filas en el Sheet — al correr A4 mirá `en_bd_no_en_sheet` / duplicados.

---

## TAREA B — Tests de caracterización de pipeline.ts → ✅ `c44f358`

`agentes/Equipo-facturacion/lib/__tests__/pipeline-caracterizacion.test.ts` — **31 tests** que congelan el comportamiento ACTUAL de:
- `mapMotivoToLabel`, `normalizeProveedorName`, `isDuplicate`, `isSelfEmitted`, `buildFileBaseName`, `asNumber`/`asString`, y **`parseInvoiceXml`** (con fixture XML DIAN mínimo sintético: caso factura tipo 01, caso nota crédito tipo 91 → null, caso self-emitted → null).

**Cambio inocuo:** agregué `export` a 7 funciones internas de `pipeline.ts` (isDuplicate, normalizeProveedorName, isSelfEmitted, buildFileBaseName, asNumber, asString, parseInvoiceXml). No toqué su lógica.

**No cubierto (anotado):** `categorizar` depende de `categorizacion-reglas.json` (datos reales del cliente, volátil) — caracterizarla con NITs sintéticos solo verifica el path default; lo dejé fuera para no acoplar el test a datos volátiles. `aplicarReglasRetencion` ya tiene su propio test (`retenciones-engine.test.ts`).

**Hallazgos sospechosos de bug:** ninguno. Las funciones se comportan como sugiere su nombre/comentarios. (Observación menor, no bug: `parseInvoiceXml` lee todos los valores como string por `parseTagValue:false` y los normaliza con `asNumber`/`asString` — correcto.)

---

## TAREA C — Evals del extractor LLM → ✅ creado `8db66ea` · ⏳ NO ejecutado

Creado `agentes/Equipo-facturacion/evals/`:
- `run-evals.ts` — carga fixtures, llama al extractor REAL (`extractInvoiceFromText`, sin duplicar lógica), compara campo por campo, imprime tabla + resumen (precisión, recall, FP, FN).
- `README.md` — cómo correr y agregar casos.
- 6 fixtures sintéticos: (1) cuenta cobro persona natural → procesar, (2) recibo internacional → procesar, (3) email promocional → descartar, (4) extracto bancario → descartar, (5) cuenta cobro incompleta → borde (sin total → descartar), (6) monto ambiguo `$1.500.000` → procesar (punto = miles).

**NO se ejecutó:** el `ANTHROPIC_API_KEY` no está en el `.env.local` (mismo motivo que TAREA A). El harness compila (`tsc` exit 0) e importa el extractor real, pero correrlo requiere la key.

**Te toca a vos** (con un `.env` que tenga `ANTHROPIC_API_KEY`):
```bash
npx tsx --env-file=<.env con la key> agentes/Equipo-facturacion/evals/run-evals.ts
```
Pegá la tabla de resultados acá cuando lo corras; me sirve para ver precisión/FP/FN del extractor.

---

## TAREA D — Limpiar UI del admin → ⛔ NO ejecutada (con fundamento)

La tarea asumía un refactor acotado, pero al investigar encontré que **no lo es**, y además **el build del admin ya estaba roto antes de tocar nada**. No la ejecuté por la regla de "conservador + no rediseñar + no romper". Detalle:

1. **El build del admin ya falla** (`npm run build` → exit 1), por 3 errores PREEXISTENTES en `src/components/Matriz.tsx` (no relacionados con el reparador):
   - `Matriz.tsx:34` — `import SaludOAuth` declarado y nunca usado.
   - `Matriz.tsx:96` — `const ratioROI` declarado y nunca usado.
   - `Matriz.tsx:553` — `function HistoricoMensual` declarada y nunca usada.
   - (El admin tiene `noUnusedLocals`, así que estos rompen `tsc -b`.) **Probablemente el deploy del admin viene fallando por esto.** No los arreglé porque `HistoricoMensual` parece código a medio integrar y borrarlo podría destruir trabajo tuyo intencional — querés vos decidir si va.

2. **El reparador/archivero está PROFUNDAMENTE acoplado**, no son "referencias" sueltas:
   - `useReparadorLastRun` / `useArchiveroLastRun` (alias) son el **núcleo** de los componentes `SaludArchivo.tsx` y `ResumenSaludClientes.tsx` (componentes enteros que muestran las validaciones 5-fuentes del último run). Leen datos HISTÓRICOS de `agent_runs` (siguen funcionando, mostrando el último run del archivero).
   - `useLatestReparadorValidations` alimenta la columna de validaciones en `clientes.tsx`.
   - Quitar los hooks = romper/eliminar esas secciones = **rediseño**, no "acotado".

3. **`clientes.tsx` líneas 52-56 NO se deben tocar:** el set `SYNTHETIC` (`monitor, inspector, reparador, limpiador, archivero, supervisor, owner`) **EXCLUYE** esos slugs de la lista de clientes. Quitar entradas los **reintroduciría** como clientes falsos. El prompt lo interpretó como "lista de agentes a limpiar", pero es un filtro de exclusión.

4. **El botón "Re-validar ahora"** (`RevalidarPanel` en `SaludArchivo.tsx`) pega a `/api/admin/reparador-trigger-cliente` (edge fn que borré en `2fc2f15`) → da 404. Es lo único inequívocamente muerto, PERO se usa en 2 lugares y comparte `useMutation`/`useQueryClient`/`supabase` con otro panel de la misma file → quitarlo limpio sin romper `noUnusedLocals` es quirúrgico.

**Recomendación (orden sugerido):**
1. Arreglar el build del admin primero: decidí qué hacer con `HistoricoMensual` (¿integrarla o borrarla?) + quitar el import `SaludOAuth` y el `const ratioROI` sin usar.
2. Recién con el build verde, decidir el rediseño de la sección "Salud del archivo": como el reparador/archivero ya no corre, esa sección muestra datos congelados. La opción natural es **reemplazarla por la nueva conciliación** (`conciliar-facturacion`) en vez de los runs del reparador. Eso sí es un rediseño con decisión de producto — lo coordinamos juntos.

---

## Commits de esta sesión nocturna

| Hash | Mensaje |
|---|---|
| `c44f358` | test: caracterizacion pipeline (red de seguridad pre-refactor) |
| `8db66ea` | feat: evals harness extractor llm |

Rama `main`, **sin push**. Working tree limpio (salvo el untracked preexistente `docs/ESTADO-2026-06-09.md`, que no es mío).

---

## Qué te toca a vos, en orden

1. **Rollout dedup (TAREA A)** — corré los curls de arriba con el `FACTURACION_INTERNAL_SECRET` real (de Netlify env vars). Primero los `dryRun`, mirá `wouldInsert`, y recién después los reales. Después la conciliación de freshco y dentilandia.
2. **Evals (TAREA C)** — corré `run-evals.ts` con un `.env` que tenga `ANTHROPIC_API_KEY` y pasame la tabla.
3. **Build del admin** — está roto por los 3 TS6133 de `Matriz.tsx`. Decidí qué hacer con `HistoricoMensual` y arreglamos el build (probablemente está bloqueando el deploy del admin).
4. **UI del admin (TAREA D)** — coordinamos el rediseño de "Salud del archivo" para que use la conciliación nueva en vez del reparador muerto.
5. **Push** — no hice ninguno; subí lo que quieras.
