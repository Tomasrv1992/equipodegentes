# Reporte — sesión autónoma 2026-06-11

> Trabajo realizado sin supervisión, bajo las reglas: commit local permitido si `tsc`+`vitest` pasan, nunca `push`, nunca tocar credenciales/.env, nunca borrar archivos, y ante ambigüedad elegir lo más conservador y seguir.

## TL;DR

- ✅ **TAREA 3** completada: lista de candidatos a limpieza en `docs/LIMPIEZA-CANDIDATOS.md` (commit `5d93f5b`).
- ⛔ **TAREA 1 y TAREA 2 NO ejecutadas**: en tu mensaje, el contenido de ambas quedó como placeholder sin pegar (`[pegá aquí el PROMPT 1B...]` / `[pegá aquí el PROMPT 2...]`). No tengo las instrucciones reales, así que no las ejecuté (decisión conservadora).
- 🔄 **Reversión importante**: revertí un borrado de archivos que había hecho en el turno anterior (ver más abajo).
- 🚫 Nada se pusheó. Todo es local.

---

## Decisiones que tomé solo

### 1. Revertí los borrados de limpieza del turno anterior
Justo antes de tu mensaje autónomo, yo estaba **ejecutando la limpieza que habías aprobado** (Grupos 1+2+3): ya había borrado 5 carpetas de agentes, 6 funciones netlify, 1 edge function y `PLAYBOOK-AGENTES.md`, y editado `netlify.toml`/`package.json` (todo sin commitear).

Tu mensaje nuevo dijo **"NUNCA borres archivos"** y **"TAREA 3 — SOLO LISTA, NO BORRAR — la decisión es mía"**. Eso recategoriza la limpieza. Como tu instrucción más reciente manda y es la más conservadora, **deshice todos esos borrados** con `git restore .` (el repo volvió al commit `8a51a33`). Verifiqué que los 5 agentes y 6 funciones quedaron restaurados y que `tsc`+`vitest` siguen verdes.

**Resultado:** no se borró ningún archivo en esta sesión. La limpieza quedó como documento de decisión para vos.

### 2. No ejecuté TAREA 1 (Conciliación)
El cuerpo era el placeholder `[pegá aquí el PROMPT 1B completo...]`. No sé qué conciliar, sobre qué cliente, ni el formato de salida esperado. Ejecutar algo inventado no aporta. **Pendiente de que pegues el PROMPT 1B real.**

### 3. No ejecuté TAREA 2 (Partir pipeline.ts)
Dos motivos:
1. El cuerpo era el placeholder `[pegá aquí el PROMPT 2 completo...]` — no tengo el plan detallado de módulos/orden.
2. Aunque tuviera el plan, es un refactor de **alto riesgo** y elegí lo conservador: `pipeline.ts` (3.182 líneas) es el corazón de facturación **en producción**, y la suite de tests actual (`dedupe-key`, `reconcile-decide`, `retenciones-engine`, `slugify`, `record-run`) **no cubre** el grueso de ese archivo (gmail/sheet/drive/sub-pipelines). Un refactor "cero cambios de comportamiento" **no sería verificable** con los tests existentes — `tsc` solo valida tipos, no comportamiento. Con vos ausente, una regresión silenciosa quedaría sin detectar.

**Recomendación:** antes de partir `pipeline.ts`, agregar tests de caracterización (parseInvoiceXml, isDuplicate, mapMotivoToLabel, sub-pipelines) que congelen el comportamiento actual. Sin esa red, el split es imprudente en modo desatendido.

---

## Commits creados en esta sesión

| Hash | Descripción |
|---|---|
| `5d93f5b` | `docs(limpieza): listado de candidatos a eliminar (sin borrar archivos)` — TAREA 3 |

**Contexto (commit previo, NO de esta sesión):** `8a51a33` `feat(facturacion): dedup de facturas a nivel BD (constraint UNIQUE, migración 0018)` — lo aprobaste explícitamente en la sesión anterior.

Estado git: rama `main`, **sin push**. Working tree limpio salvo un untracked preexistente que no es mío (`docs/ESTADO-2026-06-09.md`).

---

## Problemas encontrados

1. **Placeholders sin pegar** en TAREA 1 y TAREA 2 — bloqueante. Probablemente copiaste la plantilla del mensaje pero olvidaste pegar el contenido de `PROMPT 1B` y `PROMPT 2`.
2. **Conflicto de timing**: tu mensaje autónomo llegó mientras yo ejecutaba el borrado que habías aprobado segundos antes. Lo resolví revirtiendo (ver Decisión 1).

---

## Qué te toca a vos al volver

1. **Si querés TAREA 1 y 2:** pegá los prompts reales (`PROMPT 1B` de Conciliación y `PROMPT 2` de partir `pipeline.ts`). Sin eso no puedo ejecutarlas.
2. **Limpieza:** revisá `docs/LIMPIEZA-CANDIDATOS.md`. Si estás de acuerdo, decime "borrá el Grupo 1" (o los que quieras) y lo ejecuto con verificación. La lista ya tiene el orden de borrado seguro y las trampas (ej. editar `netlify.toml` del admin junto con la edge function).
3. **Pendiente de la sesión anterior (dedup BD, commit `8a51a33`)** — sigue sin aplicarse en producción:
   - Aplicar la migración `0018_facturas_registro_dedupe.sql` en el SQL Editor de Supabase.
   - Deploy a Netlify `equipodegentes-cron`.
   - Correr el backfill por cliente (dryRun → real), freshco primero.
4. **Push:** no hice ninguno. Si querés subir `5d93f5b` (y/o `8a51a33`), hacelo vos.
