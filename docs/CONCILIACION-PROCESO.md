# Proceso de Conciliación — arranque desde cero (1 cliente piloto)

> Objetivo: que al final de cada corrida se pueda **afirmar con evidencia** que
> ningún gasto se perdió. La ecuación que debe cerrar:
>
> **correos de gasto = procesadas_OK + descartes_legítimos + incompletas + pérdidas_reales**
>
> y que `incompletas ≈ 0` y `pérdidas_reales ≈ 0`. "Gasto" = TODO: facturas DIAN
> (.zip), cuentas de cobro (.docx) y recibos de plataforma (Meta, Google,
> Anthropic, Stripe, AWS…).

Estado: empezamos limpio (clientes borrados a propósito). **Un solo cliente
piloto** hasta que la conciliación cuadre de forma confiable. No se montan más
clientes hasta entonces.

---

## Las 4 fuentes de verdad

| Fuente | Qué aporta | Identificador |
|---|---|---|
| **Gmail** | universo de correos (labels `Facturas/YYYY` y `Descartado/YYYY`) | `messageId` |
| **agent_events** (BD) | desenlace de cada correo: `factura_procesada` (con `driveLink`), `email_descartado` (con `motivo`+`sender`) | `messageId` |
| **Sheet** | filas registradas (col E = nº documento) | `numero` |
| **Drive** | PDFs archivados | `numero` (del filename) |

La conciliación cruza **por `messageId`** (no por fecha) → inmune al desfase
recepción vs emisión. Solo 2 labels: `Facturas/` y `Descartado/`.

---

## El proceso (cada corrida)

### Paso 0 — Onboarding del cliente piloto (una sola vez)
Prerrequisito para que haya algo que conciliar.
1. **OAuth vivo:** `npm run facturacion:setup-oauth` (consentimiento Google del buzón del cliente). El token local actual está muerto (`invalid_grant`) → hay que rehacerlo.
2. **Alta en BD:** insertar el cliente en `clientes` + `client_credentials` (agente `facturacion`) con: `google_refresh_token`, `sheet_id`, `drive_folder_id`, `nit_cliente`, `google_oauth_status='connected'`, `first_run_done=false`. (Migración 0002.)
3. Verificar con: `cliente-status` (debe resolver el slug y mostrar `has_drive/has_sheet`).

### Paso 1 — Procesar
Correr el pipeline sobre el buzón (primer run = ventana amplia / `first_run`).
Clasifica y registra TODOS los gastos, etiqueta `Facturas/` o `Descartado/`, y
emite los eventos. (`facturacion-background` por el cliente, o `npm run facturacion:procesar`.)

### Paso 2 — Conciliar
Correr **el cuadre por desenlace**:
```
curl -sX POST "$CRON_URL/.netlify/functions/cuadre-facturacion" \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"clienteSlug":"<piloto>","year":2026,"format":"texto"}'
```
Devuelve, por período: `universo`, `cuadra`, y las 3 listas accionables:
`incompletas`, `descartes_sospechosos` (incl. recibos de plataforma botados),
`perdidas_reales`.

### Paso 3 — Interpretar y arreglar
- **`incompletas`** (etiquetado pero sin PDF en Drive y/o sin fila en Sheet, con `driveLink` no vacío) → reprocesar esos `messageId` con `force=true`. El constraint 0018 + `safeAppendToSheet` evitan duplicar.
- **`descartes_sospechosos`** → revisar uno por uno. Si es un gasto real (típico: recibo de Anthropic/Google/Stripe botado como "no es factura") → ajustar la clasificación ([llm-pre-filters.ts](../agentes/Equipo-facturacion/lib/llm-pre-filters.ts) / [llm-extractor.ts](../agentes/Equipo-facturacion/lib/llm-extractor.ts)) y reprocesar.
- **`perdidas_reales`** → reprocesar con `force=true` (origen `Facturas` = grave; origen `sin-label` = nunca se procesó).

### Paso 4 — Re-conciliar hasta cuadrar
Repetir Paso 2 hasta `cuadra:true` con `incompletas`, `descartes_sospechosos` y
`perdidas_reales` en ~0. Ese es el criterio de "funciona de verdad".

---

## Qué falta para correrlo mañana (prerrequisitos)
1. **Definir el cliente piloto** (slug + buzón Gmail + Sheet + carpeta Drive + NIT).
2. **Desplegar `cuadre-facturacion`** — hoy NO está desplegado (el deploy del cron está atrasado respecto al repo). Requiere push + build Netlify (con OK de Tomás).
3. **Reconectar OAuth** del buzón piloto (Paso 0.1).

## Lo que ya está listo (verificado)
- Lógica pura de conciliación driveLink-aware + remitentes-gasto: [conciliacion-decide.ts](../agentes/Equipo-facturacion/lib/conciliacion-decide.ts) — **61 tests verdes**, typecheck limpio.
- Endpoint [cuadre-facturacion.mts](../netlify/functions/cuadre-facturacion.mts) — listo, falta desplegar.

## Fuera de alcance (por ahora)
- Montar más clientes (hasta que el piloto cuadre).
- UVT 2026 / retenciones.
- Integración DIAN.
