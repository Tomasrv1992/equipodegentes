# Proceso completo Agente Facturación — Onboarding, Reset, Operación

**Última actualización:** 2026-06-11
**Cliente piloto:** Dentilandia (NIT 901.117.356) — único activo hoy
**Clientes pendientes onboarding:** 9 (paulina, tomas92, andres, java, tomas, apilados, freshco, mp-patricia-mejia, mateoramirez)
**Aplicabilidad:** este doc aplica a CUALQUIER cliente del agente, no solo Dentilandia.

---

## TL;DR — ¿Qué proceso querés?

| Escenario | Qué hacer | Doc sección |
|-----------|-----------|-------------|
| **Cliente NUEVO (paulina, tomas92, etc.)** | Onboarding desde cero | §1 |
| **Dentilandia ahora (data sucia, querés empezar limpio)** | Reset completo + re-correr año | §2 |
| **Dentilandia ahora (querés recuperar lo bueno y arreglar lo malo)** | Backfill + Reconcile (sin reset) | §3 |
| **Operación diaria normal** | Cron 7am procesa automático | §4 |

---

## §1 — Onboarding cliente NUEVO

Pasos para meter un cliente nuevo al sistema (ej: paulina). Asume que Dentilandia ya está funcionando.

### 1.1 Crear registro en BD (admin panel)

1. Abrir Panel Admin: `https://equipodegentes-admin.netlify.app`
2. Login con Google (email allowed: `tomasramirezvilla@gmail.com`)
3. Click "Clientes" → "Nuevo cliente"
4. Llenar:
   - `slug`: paulina, tomas92, etc. (lowercase, sin espacios)
   - `nombre`: "Paulina Restrepo", "Tomás Ramirez Villa", etc.
   - `nit_cliente`: NIT del cliente (sin DV, ej. `901117356`)
   - `activo`: true

### 1.2 Enviar magic-link de onboarding

1. En el cliente recién creado → click "Generar onboarding link"
2. Copiar el link → mandarle al cliente por WhatsApp/email
3. Cliente clickea el link → OAuth Google con su cuenta `gerenciaXXX@gmail.com`

### 1.3 Cliente autoriza acceso

El cliente ve un wizard que pide:
- Permisos Gmail (read + label)
- Permisos Drive (folder selection)
- Permisos Sheets (spreadsheet creation)

### 1.4 Cliente selecciona Drive + Sheet

- Drive folder destino → ej: "Operatto-PaulinaR" (carpeta nueva o existente)
- Sheet → crea uno nuevo o selecciona existente

### 1.5 Backend guarda credenciales

- `client_credentials.facturacion`:
  - `google_refresh_token` (cifrado pgcrypto)
  - `drive_folder_id`
  - `sheet_id`
  - `oauth_status` = "connected"
  - `first_run_done` = false (importante: dispara el backfill anual)

### 1.6 Primer run automático

Cuando llegue el siguiente cron (7am Bogotá), o disparar manual:
```bash
curl -X POST https://equipodegentes-cron.netlify.app/.netlify/functions/facturacion-background \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"customerId":"paulina","silent":true,"concurrency":2}'
```

`first_run_done=false` automáticamente:
- Procesa TODO el año actual (after:2026/01/01) en lugar de `30d` rolling
- Genera Sheet completo (12 pestañas mensuales + Dashboard)
- Sube PDFs DIAN a Drive en carpetas `2026-01/`, `2026-02/`, etc.
- Aplica labels Gmail `Facturas/2026` y `Descartado/2026`

### 1.7 Validación post-onboarding

Después del primer run completo:
- Sheet tiene filas en cada mes con facturas reales
- Dashboard muestra totales coherentes
- Drive tiene PDFs ordenados por mes
- Gmail: bandeja vacía o solo no-facturas, labels Facturas/Descartado poblados

---

## §2 — Reset completo Dentilandia (data desde cero)

Si querés empezar Dentilandia desde cero — borrar todo lo histórico, OAuth limpio, re-correr año entero con código nuevo.

**ATENCIÓN:** Esto es **destructivo y sin vuelta atrás**. Asegurate de:
- Tener el Sheet histórico Dentilandia EXPORTADO (Archivo → Descargar XLSX) — backup
- Tener el Drive `Operatto-Dentilandia` con backup o estar OK con perderlo
- Estar OK con re-procesar todos los emails 2026 (costo ~$3-5 LLM)

### 2.1 Pre-flight: backup manual

1. Sheet Dentilandia → Archivo → Descargar → Excel (.xlsx) → guardar en disco
2. Drive `Operatto-Dentilandia` → click derecho → Descargar (descarga ZIP de toda la carpeta)
3. Anotar el `drive_folder_id` actual y el `sheet_id` actual (los necesitarás si querés rollback)

### 2.2 Limpieza Gmail labels (manual)

En Gmail con la cuenta de Dentilandia:
1. Sidebar izquierdo → click derecho en `Facturas/2026` → "Quitar etiqueta" (NO eliminar — eso borra los emails del label pero los emails siguen existiendo)

   - Actually mejor: usar un endpoint que remueve la etiqueta de todos los emails (sin borrar). NO existe ese endpoint todavía — si querés exacto, podemos crearlo.
2. Igual con `Descartado/2026`

Alternativa más rápida: dejar los labels como están — cuando el pipeline corra de nuevo, ignora con `force=true` (re-procesa todos los emails sin importar si tienen label).

### 2.3 Limpieza Drive

Opción A: dejar la carpeta existente (PDFs se sobreescriben por `uniqueKey` del pipeline)
Opción B: renombrar carpeta vieja a `Operatto-Dentilandia-PRE-RESET-2026-06-11` y crear nueva

Opción A más simple. El pipeline NO duplica si el `uniqueKey` ya existe.

### 2.4 Reset BD (endpoint existente)

```bash
curl -X POST https://equipodegentes-cron.netlify.app/.netlify/functions/reset-cliente-facturacion \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"clienteSlug":"dentilandia"}'
```

Esto borra `agent_events` + `invoice_consecutivo_locks` + `dispatch_locks` Y resetea OAuth.

**IMPORTANTE:** después del reset, el cliente queda con `oauth_status='pending'` y `first_run_done=false`. Necesita **reonboardear OAuth** desde el panel admin (§1.2-1.5).

### 2.5 Re-conectar OAuth (panel admin)

1. Panel admin → cliente Dentilandia → "Re-generar onboarding link"
2. Tomás clickea (vos sos quien tiene acceso al Gmail de Dentilandia)
3. Re-autoriza Google con la misma cuenta
4. Selecciona el MISMO drive_folder_id y sheet_id (para no perder el archivo)

### 2.6 Primer run desde cero

```bash
curl -X POST https://equipodegentes-cron.netlify.app/.netlify/functions/facturacion-background \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"customerId":"dentilandia","force":true,"silent":true,"concurrency":2}'
```

`force=true` + `first_run_done=false` → procesa TODO el año 2026 sin importar labels Gmail.

Tarda ~30-60 min. Mientras corre, podés monitorear:
```bash
curl -X POST .../inspect-runs -d '{"clienteSlug":"dentilandia","limit":3,"year":2026}'
```

### 2.7 Validación post-reset

- Sheet limpio con filas nuevas, Dashboard cuadra
- Drive con PDFs ordenados (NO `.xml`)
- Gmail labels `Facturas/2026` y `Descartado/2026` poblados con código nuevo
- BD `agent_events` con messageId en cada factura_procesada

---

## §3 — Arreglar Dentilandia SIN reset (Backfill + Reconcile)

Más complejo pero NO destructivo. Para si NO querés perder histórico.

Pasos (ya tenemos código deployado al 11-jun 2026):

1. **Backfill messageId** (`backfill-messageid-background.mts`)
   - Recupera messageId histórico para events factura_procesada que no lo tienen
   - DryRun primero, real después
   - Cobertura esperada: ≥80%

2. **Reproceso CC** (`facturacion-background.mts` con `force=true`)
   - Re-procesa emails de `Descartado/2026` que ahora con LLM forceProcess + umbral 0.2 + fallback subject van a entrar al Sheet
   - Costo ~$3-5 LLM

3. **Reconcile labels** (`reconcile-labels-background.mts`)
   - Una vez backfill aplicado, reconcile pone los labels Gmail correctos según events BD
   - DryRun primero, real después

Documentado en detalle en `REPORTE-NOCHE-2026-06-09.md` secciones 5-6.

---

## §4 — Operación diaria normal

Cron Netlify dispara `facturacion-cron.mts` todos los días a las **7:00 AM Bogotá** (12:00 UTC).

Por cliente activo:
1. Pipeline busca emails Gmail nuevos: `(filename:zip OR filename:pdf OR ...) -label:Facturas/YYYY -label:Descartado/YYYY -label:Procesado after:YYYY/01/01`
2. Por cada email procesa según tipo:
   - ZIP DIAN → parser XML → si InvoiceTypeCode `01` o `02`, valida + sube PDF a Drive + fila Sheet + label `Facturas/YYYY`
   - PDF planilla SS → si titular == NIT cliente, procesa; sino → `Descartado/YYYY` motivo `planilla-ss-tercero`
   - DOCX → LLM extrae → si fallback subject "cuenta de cobro" rescata → procesa
   - PDF genérico → LLM extrae → procesa o descarta
3. Cada exitosa: emit `agent_events tipo=factura_procesada` con `messageId`
4. Cada descartada: emit `agent_events tipo=email_descartado` con motivo
5. Si configurado, manda email diario al cliente con resumen

### Monitoreo diario

```bash
# Ver último run cliente
curl -X POST .../inspect-runs -d '{"clienteSlug":"dentilandia","limit":3,"year":2026}'

# Sheet state
curl -X POST .../inspect-sheet -d '{"clienteSlug":"dentilandia","tabs":["Junio"]}'

# Descartes con motivo
curl -X POST .../inspect-descartes -d '{"clienteSlug":"dentilandia","year":2026}'
```

---

## §5 — Issues conocidos + Decisiones de diseño

### Notas crédito DIAN (TipoDoc 05/07/91/92)
**Decisión 2026-06-11:** se descartan. NO se contabilizan como gasto en el Sheet. Motivo descarte: `no-es-factura-dian`.

### Cuentas de cobro DOCX/PDF
**Decisión 2026-06-09:** umbral LLM 0.4 default, baja a 0.2 SOLO si subject matchea pattern CC (`cuenta de cobro`, `CC Mes Año`, `documentación cuenta de cobro`, `SMB`). Recupera falsos negativos sin abrir la puerta a basura genérica.

### XMLs DIAN en Drive
**Decisión 2026-06-09:** NO se suben al Drive. Solo el PDF. XML sigue en el ZIP del email Gmail original (descargable si auditor lo pide).

### Nombre comercial vs persona natural (régimen simplificado)
**Pendiente:** algunos proveedores facturan como persona natural (XML: "Ruby Sulay Ramirez Lopez") pero usan nombre comercial (PDF: "Laboratorio Dental Ramírez Ruby"). El Sheet hoy guarda lo del XML.

Fix futuro: override por NIT en `categorizacion-reglas.json`:
```json
{
  "reglas_por_nit": {
    "1040182652": {
      "proveedor_display": "Laboratorio Dental Ramírez Ruby",
      "categoria": "Laboratorio dental",
      "cuenta_pyg": "5135 - Servicios"
    }
  }
}
```
Requiere modificar `pipeline.ts` para leer `proveedor_display` y sobrescribir el extraído. ~30 min de trabajo.

### Consecutivos (col A Sheet)
**Eliminados 2026-06-03.** Col A queda vacía en filas nuevas. Causa principal de bugs históricos (race conditions, renumeración, etc.). Dashboard usa col E (#Documento) para contar.

### Plan compute Supabase
**Recomendado upgrade a Small ($10/mes)** cuando se escale a >3 clientes activos. Plan actual (Shared + 0.5GB) se satura con queries pesadas.

---

## §6 — Costos operacionales

| Item | Costo aprox |
|------|-------------|
| Netlify Functions | Free tier alcanza para ~100k invocaciones/mes |
| Anthropic Haiku (LLM no-DIAN) | ~$0.003 USD por extracción. Dentilandia ~50/mes = $0.15. Si 9 clientes: ~$1.5/mes |
| Supabase | Free actual. Upgrade Small $10/mes recomendado |
| Resend (emails) | Free tier 3000/mes |
| **Total proyectado 10 clientes** | **~$15-25 USD/mes** |

---

## §7 — Checklist agente nuevo (si vos te incorporás otro dev)

- [ ] Leer `docs/ESTADO-2026-06-09.md` (estado del arte técnico)
- [ ] Leer `docs/PROCESO-DENTILANDIA.md` (este archivo)
- [ ] Leer `REPORTE-NOCHE-2026-06-09.md` (sprint desatasco)
- [ ] Crear `.env.local` con env vars (lista en ESTADO-2026-06-09 §A)
- [ ] Correr `npx tsc --noEmit` (debe pasar)
- [ ] Correr `npx -y vitest run reconcile-decide` (7/7 debe pasar)
- [ ] Verificar acceso a Supabase Dashboard
- [ ] Verificar acceso a Netlify Functions logs

---

**Fin del documento.** Mantenelo actualizado con decisiones futuras.
