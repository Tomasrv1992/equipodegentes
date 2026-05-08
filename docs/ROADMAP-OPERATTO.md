# Roadmap Operatto

> Lista viva de pendientes técnicos y features. Se actualiza cada vez que descubrimos algo nuevo o priorizamos. Ordenado por urgencia + impacto.

---

## ✅ Hecho (Mayo 2026)

- ✅ Panel admin Operatto con Hero + KPIs + ClientCards + Timeline 24h + Sparkline
- ✅ Cron de facturación migrado a sitio dedicado (`equipodegentes-cron`) con escritura a Supabase
- ✅ Sistema de runs con instrumentación end-to-end (recordRunStart/End)
- ✅ Drill-down de runs con classify-error + acciones (re-disparar)
- ✅ Cliente ficha con mini-KPIs + bar chart 6 meses
- ✅ Agente ficha con KPIs cross-cliente + histórico 12 meses
- ✅ Multi-tenant Fase 3: OAuth flow web del cliente + onboarding token + cron iterativo

---

## 🔴 Próximo (P0) — bloqueante para vender al primer cliente externo

### CRÍTICO. **Conteos por mes basados en fecha REAL de la factura, no del run**

**Problema detectado** (2026-05-07): después del backfill de tomas92 con 32 facturas, el panel admin muestra todas en "Mayo" (cuando se procesaron) — pero las facturas son de Enero, Febrero, Marzo, Abril y Mayo. Drive las separa correctamente en carpetas `2026-01`, `2026-02`, etc. Pero el panel agrupa por `agent_runs.started_at` (fecha del run = mayo).

**Resultado**: panel admin NO coincide con Drive, NI con Sheet, NI con email del resumen.

**Solución**:
1. Crear filas en `public.agent_events` (ya existe la tabla) — una por cada factura procesada con:
   - `tipo = 'factura_procesada'`
   - `payload = { fecha, proveedor, nit, numero, total, categoria, drive_link }`
   - `created_at = now()` (cuándo se registró) + indexar por fecha de factura
2. En `pipeline.ts` después de cada `processOne` exitoso, insertar agent_event
3. Modificar `aggByMonth` (lib/metrics.ts) para usar `payload->fecha` (fecha real factura) en vez de `started_at`
4. Modificar KPIs "Procesadas mes / 7 días / all-time" para contar agent_events por su fecha
5. **Resultado**: bar chart Operatto coincide exactamente con Drive y Sheet

**Estimado**: 2-3h (refactor mediano). **Bloquea**: ningún feature pero es un bug de coherencia visible para el cliente.

---


### 0. **Extracción de retenciones (ReteFuente, ReteIVA, ReteICA) + reglas configurables**

**Por qué**: el agente hoy extrae subtotal/IVA/total. Para que sea **contablemente útil
en Colombia** necesita extraer también las retenciones que se aplican a la factura,
porque definen lo que efectivamente se paga al proveedor y lo que queda como crédito
fiscal del cliente. Sin esto, el contador del cliente igual tiene que abrir cada
factura manualmente — perdemos buena parte del valor del agente.

**Las 3 retenciones colombianas**:

| Retención | Cuándo aplica | Tasa típica |
|---|---|---|
| **ReteFuente (RetenciónIvaIca)** | Servicios y compras según concepto | 1% – 11% |
| **ReteIVA** | Si el cliente es agente retenedor de IVA | 15% del IVA facturado |
| **ReteICA** | Compras a proveedores con domicilio en municipios donde el cliente paga ICA | 0.4% – 1% |

**Implementación técnica**:

1. **Extracción del XML**: extender `parseInvoiceXml()` en `pipeline.ts` para leer
   los nodos `cac:WithholdingTaxTotal` del XML DIAN. Cada uno tiene un código
   (`05`=ReteFuente, `06`=ReteIVA, `07`=ReteICA según DIAN). Devolver:
   ```ts
   reteFuente: number;
   reteIva: number;
   reteIca: number;
   totalRetenciones: number;
   ```

2. **Sheet del cliente**: agregar 4 columnas (después de IVA, antes de Total):
   `ReteFuente · ReteIVA · ReteICA · Total Retenciones`. Total real (lo que se
   paga al proveedor) = Total - Total Retenciones. Útil para conciliar con pagos.

3. **agent_events**: agregar al `payload` los 4 campos. Permite agregar al
   Dashboard del Sheet una sección "Retenciones del mes".

4. **Sistema de reglas configurables** — para casos donde el XML NO trae la
   retención pero el cliente la aplica de oficio (caso común con proveedores
   que no facturan retenciones por estar bajo régimen simplificado):

   ```json
   // client_credentials.retention_rules (jsonb nuevo)
   {
     "default": {
       "reteFuente_porcentaje": 0,
       "reteIva_porcentaje": 0,
       "reteIca_porcentaje": 0
     },
     "por_categoria": {
       "Honorarios profesionales": { "reteFuente_porcentaje": 11 },
       "Servicios técnicos": { "reteFuente_porcentaje": 6 }
     },
     "por_nit": {
       "900123456": { "reteFuente_porcentaje": 0 }  // proveedor exento
     },
     "umbral_minimo": {
       "reteFuente_uvt": 4,  // 4 UVT mínimo para retener fuente
       "reteIca_uvt": 4
     }
   }
   ```

   Lógica de cálculo en pipeline:
   1. Si XML trae retención → usar esa (es la oficial)
   2. Si XML no trae → calcular por reglas: `por_nit` > `por_categoria` > `default`
   3. Aplicar umbral mínimo (no retener facturas pequeñas)
   4. Marcar la fila como "ret. calculada" vs "ret. del XML" para auditoría

5. **UI panel admin**: pantalla "Reglas de retención" en ficha del cliente con
   editor de las reglas (JSON o form visual). Preview con últimas 10 facturas.

6. **Email mensual** y **Dashboard del Sheet**: agregar sección "Retenciones
   aplicadas este mes" con totales por tipo.

**Estimado**: 2 sesiones (~5-6h total).
- Sesión 1: parseInvoiceXml + columnas Sheet + agent_events (~3h)
- Sesión 2: sistema de reglas + UI panel admin (~3h)

**Bloquea**: nada técnico. **Habilita**: que el agente sea contablemente
completo y desbloquee el siguiente segmento de clientes (PyMEs con contadora
externa que necesitan info de retenciones).

---

### 1. **Email mensual automático del resumen al cliente**

**Por qué**: el cliente paga por el agente — necesita ver valor entregado cada mes.

**Spec del email** (template Resend HTML):
```
Asunto: Resumen mensual Equipo de Facturación — {Mes Año}

Hola {cliente.nombre},

Acá el resumen del mes:

- Facturas procesadas: {N}
- Total registrado: ${monto_total formateado COP}
- Top 3 proveedores: {A}, {B}, {C}
- Categorías más usadas: {top_3_categorias}
- Errores resueltos: {N}
- Tiempo ahorrado estimado: {X horas} (≈ 24 min/factura)

Link al dashboard: {client_credentials.sheet_id → URL del Sheet}

Avisame si querés que ajustemos algo.
```

**Implementación**:
- Nueva Netlify scheduled function `facturacion-monthly-report` que corre el día 1 de cada mes a las 9am
- Itera sobre `client_credentials` activos del agente facturacion
- Para cada uno:
  1. Lee `agent_runs` + `agent_events` del mes anterior agrupado por cliente
  2. Calcula: total facturas (sum payload.procesadas), monto (necesita parsear payload extendido), top proveedores (necesita guardar más detalle en agent_events)
  3. Renderiza HTML del email
  4. Envía via Resend a `client_credentials.notify_email`
- Guardar log del envío como `agent_runs` con `agente_id='facturacion'` y `triggered_by='monthly_report'`

**Pre-requisito de datos**: hoy `agent_runs.payload` solo tiene `{procesadas, errores, saltadas}`. Para el email rico necesitamos:
- Que `pipeline.ts` devuelva en cada `ProcessedRow` los campos necesarios (proveedor, categoria, total) — ya los devuelve
- Que el background fn los guarde como `agent_events` por cada factura procesada (uno por factura) o que extienda `payload` con array de procesadas

**Estimado**: 1 sesión (~3-4h). Bloquea: que `pipeline.ts` cargue los detalles a `agent_events` o `payload` extendido.

### 2. **Reglas de categorización por cliente**

**Por qué**: hoy `agentes/Equipo-facturacion/lib/categorizacion-reglas.json` es UN archivo compartido. Cada cliente tiene su propio plan de cuentas (cliente clínica vs cliente retail tienen categorías totalmente distintas).

**Spec**:
- Agregar columna `categorization_rules` jsonb a `client_credentials`
- En `pipeline.ts` `categorizar()`, primero consultar las reglas del cliente, fallback al archivo compartido como default
- En el panel admin: pantalla "Reglas de categorización" en ficha del cliente — editor JSON con preview

**Estimado**: 1 sesión (~3h)

---

## 🟠 Importante (P1) — robustez y experiencia

### NEW. **Operatto crea Sheet + carpeta automáticamente durante onboarding**

**Por qué**: hoy el cliente tiene que tener pre-creados un Sheet y una carpeta Drive antes del onboarding. Fricción innecesaria.

**Spec**:
- Durante `/auth/google/callback` (después de guardar el refresh_token), llamar Drive API:
  1. Crear carpeta: `Facturas {cliente.nombre} - Operatto` en root del Drive del cliente
  2. Crear Sheet: `Control Facturas {cliente.nombre}` dentro de esa carpeta (no en root)
  3. Inicializar headers en pestaña "Gastos 2026": `Fecha · Proveedor · NIT · N° factura · Subtotal · IVA · Total · Concepto · Categoría · Cuenta PYG · Drive link`
- Pre-llenar `client_credentials.drive_folder_id` y `sheet_id` con los recién creados
- En `/onboarding` paso 2, mostrar "Ya creamos esto para vos: [Sheet] [Carpeta]" con opción "Quiero usar otros" (para flexibilidad)

**Estimado**: 2h. Aumenta calidad de onboarding 10x.

### Reordenado: lo que sigue mantiene su orden previo


### 3. **Onboarding link via email automático (no copy-paste manual)**

Hoy: Tomás click "Crear link" → copia y manda por WhatsApp.
Ideal: cliente recibe email automático con el link.

**Implementación**:
- Edge function `admin-create-onboarding` envía email via Resend al `cliente.email` (campo nuevo)
- Template: "Hola {cliente}, soy Tomás de Operatto. Para activar tu agente de facturación, click acá: {link}"
- En el form Nuevo cliente: campo `email` requerido para que el botón "Enviar onboarding" funcione

**Estimado**: 1 sesión (~2h)

### 4. **Dashboard de métricas de negocio**

Hoy: panel ops (¿está corriendo?). Falta: dashboard "cuánto valor he generado".

**Spec**:
- Sección global "Operatto en cifras" en home: total facturas all-time, $$ procesado, horas ahorradas, # clientes activos
- Por cliente: histórico de procesadas + tiempo ahorrado mes a mes
- Exportar PDF mensual del cliente para la facturación de Operatto al cliente

**Estimado**: 1 sesión (~3h)

### 5. **Notificaciones a Tomás cuando algo falla**

Hoy: si el cron de un cliente falla, Tomás se entera entrando al panel.
Ideal: Slack/email a Tomás cuando un cliente entra en estado `fail` o `expired`.

**Implementación**:
- En `recordRunEnd` con status fail+ tener un mecanismo de webhook
- O scheduled fn cada hora que mira `agent_runs` con status fail/warn de la última hora y manda alertas

**Estimado**: medio día

---

## 🟡 Nice-to-have (P2) — pulido y escalabilidad

### 6. **Verificación oficial Google Cloud**

Hoy: Modo Testing limitado a 100 test users.
Cuando: al llegar a 50+ clientes.

**Trabajo**:
- App review formal de Google (formulario + revisión de seguridad)
- Privacy Policy URL pública
- Domain verification
- 2-6 semanas de espera

### 7. **Multi-agente — Equipo-cartera production-ready**

Hoy: cartera está en MVP local Python.
Para producción multi-tenant: replicar el patrón de facturación (cron Netlify, Supabase, OAuth, etc).

### 8. **Realtime updates en panel**

Supabase Realtime → matriz se actualiza sola cuando el cron escribe.

### 9. **Audit log de acciones**

Tabla `audit_events` que registra: re-disparar, pausar agente, editar config, etc.

### 10. **Historial extendido (>12 meses)**

Hoy: `aggByMonth` muestra 12 meses. Para multi-año: vista "All-time" con datos agregados por año.

### 11. **Backup automático de Sheets**

Cada mes copiar el Sheet del cliente a un Drive de respaldo Operatto.

---

## 🔵 Decisiones diferidas

- **Pricing y facturación de Operatto al cliente**: cómo cobramos? Mensual fijo? Por factura procesada? Decisión de negocio fuera de scope técnico.
- **Branding cliente**: ¿el cliente ve "Operatto" en sus emails y panel, o whitelabel?
- **App propia (mobile)**: hoy es web-only; ¿vale la pena nativa?

---

## 🟢 Operacional / housekeeping

- Apagar cron viejo en `consultoria-ea` cuando confirmemos que el nuevo corre OK por 1 semana (Bloque E del [MIGRAR-CRON-A-EQUIPODEGENTES.md](MIGRAR-CRON-A-EQUIPODEGENTES.md))
- Mergear `feat/admin-panel` a `main` cuando todo esté validado
- Cambiar Production branch en Netlify de `feat/admin-panel` → `main`
