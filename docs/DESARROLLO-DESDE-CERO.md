# Desarrollo desde cero — Equipo de Facturación

**Última actualización:** 2026-06-11
**Audiencia:** Dev nuevo (o futuro yo) que arranca el proyecto desde cero. Cubre infra + setup + primer cliente operativo.

---

## TL;DR — Lo que vas a tener al final

Sistema multi-tenant que automatiza captura, categorización y registro contable de facturas DIAN colombianas. 1 cliente piloto operativo (Dentilandia) procesando ~50 facturas/mes. Cron diario 7am Bogotá. Costo operativo total <$25 USD/mes para 10 clientes.

---

## 1. Stack tecnológico (lo que vas a tocar)

| Componente | Para qué | Plan recomendado |
|------------|----------|------------------|
| **TypeScript** + **Node.js 20+** | Lenguaje del pipeline | — |
| **Netlify Functions** | Hosting serverless (cron 7am, background workers 15min) | Pro plan ($19/mes) recomendado para Background Functions sin límite |
| **Supabase Postgres** | BD multi-tenant + Auth + pgcrypto (cifrado OAuth) | Pro plan ($25/mes Small compute) para >3 clientes activos |
| **Google APIs** | Gmail (lee emails), Drive (sube PDFs), Sheets (escribe filas) | OAuth Web Application gratis |
| **Anthropic Claude Haiku 4.5** | LLM para extraer datos de PDFs/DOCX no-DIAN | ~$3/mes por 10 clientes activos |
| **Resend** | Emails diarios al cliente con resumen | Free tier alcanza |
| **GitHub** | Repo + CI/CD (vía Netlify) | Free |

---

## 2. Setup desde cero (paso a paso, 2-3 horas)

### 2.1 Cuentas externas que vas a crear

1. **GitHub** — clonar el repo `equipodegentes` (este repo)
2. **Supabase** — crear proyecto en `app.supabase.com`
3. **Netlify** — conectar GitHub al proyecto Netlify
4. **Google Cloud Console** — crear OAuth Client Web Application
5. **Anthropic Console** — crear API key
6. **Resend** — crear API key + verificar dominio sender

### 2.2 Supabase — crear proyecto

1. `app.supabase.com` → New project
2. Región: **South America (São Paulo)** (más cercana a Colombia)
3. Plan: **Small ($25/mes)** desde el día 1 si vas a poner >1 cliente
4. Anotar: `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` (Settings → API)

### 2.3 Supabase — schema inicial

Ejecutar migraciones del repo en orden, vía SQL Editor manual:

```bash
# Migraciones que vas a aplicar (en orden):
docs/superpowers/migrations/0001_*.sql
docs/superpowers/migrations/0002_*.sql
# ... hasta la última (a 2026-06-11 es 0017_reconcile_dumps.sql)
```

Cada migración crea tablas/RPCs/triggers. Aplicar **una por una** en SQL Editor (no en batch). Si alguna es `CREATE INDEX CONCURRENTLY`, va separada porque no corre en transacción.

Tablas que vas a tener al final:
- `clientes` — multi-tenant base
- `client_credentials` — OAuth tokens cifrados pgcrypto
- `client_agents` — relación cliente↔agente activado
- `agent_runs` — histórico de runs cron
- `agent_events` — event log granular (1 row por factura/descarte)
- `dispatch_locks` — lock atómico anti-stampede
- `onboarding_tokens` — magic links one-time
- `reconcile_dumps` — rollback state de reconcile-labels
- `audit_log` — auditoría general

### 2.4 Google Cloud — OAuth Client Web

1. `console.cloud.google.com` → New project
2. Habilitar APIs:
   - Gmail API
   - Google Drive API
   - Google Sheets API
3. APIs & Services → OAuth consent screen → External, scopes:
   - `gmail.modify` (labels)
   - `drive.file` (subir PDFs)
   - `spreadsheets` (escribir filas)
4. APIs & Services → Credentials → Create OAuth Client ID → Web Application
5. Authorized redirect URIs: `https://TU-DOMINIO.netlify.app/.netlify/functions/oauth-callback`
6. Anotar: `GOOGLE_OAUTH_WEB_CLIENT_ID` + `GOOGLE_OAUTH_WEB_CLIENT_SECRET`

### 2.5 Anthropic — API key

1. `console.anthropic.com` → API Keys → Create
2. Cargar saldo inicial (~$20 alcanza para 6 meses con 10 clientes)
3. Anotar: `ANTHROPIC_API_KEY`

### 2.6 Resend — emails

1. `resend.com` → API Keys → Create
2. Domains → agregar tu dominio + verificar DNS
3. Anotar: `RESEND_API_KEY`, `NOTIFY_EMAIL_FROM` (ej `notificaciones@tudominio.com`)

### 2.7 Netlify — conectar repo

1. `app.netlify.com` → New site from Git → seleccionar el repo
2. Build command: `npm install` (no hay build de TypeScript, las functions usan tsx directo)
3. Functions directory: `netlify/functions`
4. Env vars (Settings → Environment variables):

```
SUPABASE_URL=<de paso 2.2>
SUPABASE_SERVICE_ROLE_KEY=<de paso 2.2>
CREDENTIALS_VAULT_KEY=<generar random 32 char hex>
GOOGLE_OAUTH_WEB_CLIENT_ID=<de paso 2.4>
GOOGLE_OAUTH_WEB_CLIENT_SECRET=<de paso 2.4>
ANTHROPIC_API_KEY=<de paso 2.5>
RESEND_API_KEY=<de paso 2.6>
NOTIFY_EMAIL_FROM="Tu Nombre <notificaciones@tudominio.com>"
FACTURACION_INTERNAL_SECRET=<generar random 64 char hex>
MIN_INVOICE_YEAR=2026
EMAILS_ENABLED=false  # mute por defecto hasta validar
```

5. Deploy → esperar build OK

### 2.8 Repo local (vos como dev)

```bash
git clone https://github.com/Tomasrv1992/equipodegentes.git
cd equipodegentes
npm install
# Crear .env.local copiando .env.sample y rellenar con las env vars de arriba
cp .env.sample .env.local
# Editar .env.local con tus valores
```

Verificar que typecheck pasa:
```bash
npx tsc --noEmit
# Debe terminar con exit code 0
```

Verificar que tests pasan:
```bash
npx -y vitest run
# Debe pasar todos (al 2026-06-11 son 7 tests reconcile-decide)
```

### 2.9 Panel admin (apps/admin)

El panel admin es un app Vite/React separado en `apps/admin/`. Para deployarlo:

1. En Netlify, crear OTRO sitio para `apps/admin` (mismo repo, base directory `apps/admin`)
2. Build command: `npm run build`
3. Publish directory: `dist`
4. Env vars del admin:

```
VITE_SUPABASE_URL=<mismo que paso 2.2>
VITE_SUPABASE_ANON_KEY=<de Settings → API → anon key>
VITE_FACTURACION_API_URL=<URL del site principal Netlify>
ADMIN_ALLOWED_EMAIL=tuemail@gmail.com  # tu cuenta Gmail para login
```

5. Deploy

---

## 3. Primer cliente — onboarding

Ya tenés infra. Para meter el primer cliente (ej. "miprimercliente"):

### 3.1 Crear cliente en BD

Vía SQL Editor en Supabase:

```sql
INSERT INTO clientes (slug, nombre, nit_cliente, activo)
VALUES ('miprimercliente', 'Mi Primer Cliente SAS', '901234567', true);

INSERT INTO client_agents (cliente_id, agente_id, activo)
SELECT id, 'facturacion', true FROM clientes WHERE slug='miprimercliente';
```

### 3.2 Generar onboarding link (panel admin)

1. Login en `apps/admin` con tu email
2. Click "Clientes" → "miprimercliente" → "Generar onboarding link"
3. Copiar el link generado

### 3.3 Cliente hace OAuth flow

Mandale el link al cliente (WhatsApp/email). Cliente clickea, autoriza Google con su cuenta `gerenciaXXX@gmail.com`, selecciona:
- Drive folder destino: crear nuevo "Operatto-MiPrimerCliente" (o seleccionar existente)
- Sheet: crear nuevo o seleccionar existente

Backend guarda `google_refresh_token` cifrado en `client_credentials.facturacion`.

### 3.4 Primer run

```bash
curl -X POST https://TU-DOMINIO.netlify.app/.netlify/functions/facturacion-background \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -H "content-type: application/json" \
  -d '{"customerId":"miprimercliente","force":true,"silent":true,"concurrency":2}'
```

`first_run_done=false` (porque es nuevo) → procesa todo el año actual desde `2026/01/01`. Tarda 5-30 min según volumen.

### 3.5 Verificación

- Sheet del cliente tiene filas en pestañas Enero..mes actual
- Drive tiene PDFs ordenados por mes
- Gmail del cliente tiene labels `Facturas/2026` y `Descartado/2026` aplicados
- BD `agent_events` tiene filas tipo=`factura_procesada` con `messageId`

---

## 4. Operación diaria

El cron Netlify `facturacion-cron.mts` corre cada día a las 12:00 UTC (7am Bogotá). Por cada cliente activo:

1. Busca emails Gmail nuevos: `(filename:zip OR pdf OR docx) -label:Facturas/YYYY -label:Descartado/YYYY after:YYYY/01/01`
2. Por cada email:
   - ZIP DIAN → parse XML → factura
   - PDF planilla SS → si titular = NIT cliente, procesa
   - DOCX → LLM Claude → cuenta de cobro
   - PDF genérico → LLM → recibo
3. Si exitoso: PDF a Drive + fila Sheet + label `Facturas/YYYY` + INBOX removido
4. Si descartado: solo label `Descartado/YYYY` + INBOX removido + event con motivo
5. Email diario al cliente con resumen (si `EMAILS_ENABLED=true`)

---

## 5. Monitoreo

```bash
# Último run de un cliente
curl -X POST https://TU-DOMINIO.netlify.app/.netlify/functions/inspect-runs \
  -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
  -d '{"clienteSlug":"miprimercliente","limit":5,"year":2026}'

# Estado Sheet
curl -X POST .../inspect-sheet -d '{"clienteSlug":"miprimercliente","tabs":["Junio"]}'

# Descartes con motivo
curl -X POST .../inspect-descartes -d '{"clienteSlug":"miprimercliente","year":2026}'
```

Panel admin tiene UI para todo esto. Es lo que usás día a día.

---

## 6. Decisiones de diseño importantes (no cambiar sin entender)

| Decisión | Razón |
|----------|-------|
| **NO consecutivos en col A del Sheet** | Causaba race conditions, renumeración, bugs eternos. Col E (#Documento) es identificador único |
| **NO subir XMLs al Drive** | Generaban filenames "FE1234.1, FE1234.2" confusos. XML siempre disponible en ZIP del email |
| **NO label Procesado** | Redundante con Facturas/YYYY y Descartado/YYYY. Solo confunde |
| **Notas crédito DIAN (TipoDoc 05/07/91/92) se descartan** | NO son gastos del cliente, son comprobantes de cobro NO realizado |
| **LLM umbral confianza 0.4** (default) | Más conservador. Baja a 0.2 SOLO si subject matchea "cuenta de cobro" / "nota de cobro" |
| **messageId en factura_procesada payload** | Permite reconcile-labels determinístico. Sin esto, los migradores usan heurísticas que producen overlap |
| **Override nombre comercial** (`proveedor_display` en `categorizacion-reglas.json`) | Régimen simplificado: XML trae persona natural, comercio usa nombre fantasía |

---

## 7. Cuando algo falla

| Síntoma | Causa probable | Fix |
|---------|---------------|-----|
| Endpoint timeout 504 | Supabase saturado / queries sin índice | Aplicar migración 0016_indices_agent.sql |
| OAuth `invalid_grant` | Refresh token caducó (Google revoca tras 6 meses inactivo) | Cliente reonboardea desde panel admin |
| Cron caído >2 días | Saldo Netlify/Anthropic agotado | Recargar + retrigger manual: `curl .../facturacion-background -d '{"customerId":"X","silent":true}'` |
| Sheet con duplicados | Bug histórico (resuelto 2026-05). Si pasa: ejecutar reset + reonboarding | Ver `docs/PROCESO-AGENTE-FACTURACION.md` §2 |
| Cliente reporta facturas perdidas | Falso negativo LLM o pre-filter | Diagnóstico SQL: `agent_events` filtrar por proveedor → ver motivo descarte |

---

## 8. Roadmap pendiente (sprint futuro)

- [ ] Refactor `pipeline.ts` (3.000 líneas) en módulos chicos
- [ ] Tests unitarios para `parseInvoiceXml`, `validations.ts`, `llm-extractor.ts`
- [ ] Backfill UVT 2026 oficial cuando DIAN publique
- [ ] Borrar agentes muertos (`Equipo-monitor`, `reparador`, `limpiador`, `supervisor`)
- [ ] TTL en `agent_events` (archivar >12 meses)
- [ ] Endpoint `onlyMotivos` para reproceso acotado
- [ ] Panel admin para configurar reglas de categorización por NIT desde UI

---

## 9. Costos proyectados (10 clientes activos)

| Item | Costo mensual USD |
|------|---|
| Netlify Pro (Background Functions sin límite) | $19 |
| Supabase Small (2 vCPU + 1GB) | $25 |
| Anthropic Haiku (50 facturas LLM/cliente/mes) | $1.50 |
| Resend (free tier 3000/mes alcanza) | $0 |
| **Total** | **~$45.50/mes** |

Si tenés <3 clientes: Netlify Free + Supabase Free → ~$1.50/mes (solo LLM). Pero saturás rápido.

---

## 10. Glosario

| Término | Definición |
|---------|-----------|
| **DIAN** | Dirección de Impuestos colombiana |
| **CUFE** | Código Único de Factura Electrónica (UUID del XML DIAN) |
| **NIT** | Número de Identificación Tributaria colombiano (6-11 dígitos + opcional DV) |
| **DV** | Dígito de Verificación (último dígito del NIT, opcional según contexto) |
| **UVT** | Unidad de Valor Tributario (cambia anualmente, base cálculos retención) |
| **RTF / ReteFuente** | Retención en la Fuente (% sobre subtotal según categoría) |
| **ReteIVA** | Retención de IVA (servicios consultoría) |
| **ReteICA** | Retención de Impuesto Industria y Comercio (por municipio) |
| **Régimen simplificado** | Persona natural sin obligación de IVA. XML DIAN trae nombre natural, no comercial |
| **Cuenta de cobro** | Documento de cobro no-electrónico (Word/PDF), típico de proveedores sin facturación DIAN |
| **TipoDoc 01/02** | Factura electrónica DIAN (procesar) |
| **TipoDoc 05/07/91/92** | Notas crédito/débito DIAN (descartar) |

---

## 11. Archivos clave del repo

```
equipodegentes/
├── agentes/Equipo-facturacion/lib/
│   ├── pipeline.ts                    ← 3.000 líneas, core del flujo
│   ├── llm-extractor.ts               ← interfaz Claude
│   ├── llm-pre-filters.ts             ← heurísticas sender/subject
│   ├── doc-parsers.ts                 ← extracción texto docx/pdf
│   ├── validations.ts                 ← validaciones numero/fecha/NIT
│   ├── retenciones-engine.ts          ← RTF/IVA/ICA
│   ├── retenciones-constants.ts       ← UVT, tarifas
│   ├── reconcile-decide.ts            ← función pura testeable
│   ├── categorizacion-reglas.json     ← mapping NIT → categoría
│   └── __tests__/                     ← vitest tests
├── netlify/functions/
│   ├── facturacion-cron.mts           ← scheduled 7am Bogotá
│   ├── facturacion-background.mts     ← worker 15min
│   ├── inspect-*.mts                  ← endpoints diagnóstico
│   ├── reset-cliente-facturacion.mts  ← reset BD per cliente
│   ├── backfill-messageid-*.mts       ← migrar histórico
│   └── reconcile-labels-*.mts         ← reconciliar labels Gmail
├── shared/agents-runtime/src/
│   ├── supabase-server.ts             ← cliente Supabase
│   ├── agent-events.ts                ← emit events factura_procesada
│   ├── credentials.ts                 ← OAuth tokens cifrados
│   └── preflight.ts                   ← validación OAuth pre-run
├── apps/admin/                        ← Panel Vite/React
└── docs/
    ├── ESTADO-2026-06-09.md           ← estado técnico actual
    ├── PROCESO-AGENTE-FACTURACION.md  ← onboarding/reset/operación
    ├── DESARROLLO-DESDE-CERO.md       ← este archivo
    └── superpowers/migrations/        ← SQL migrations Supabase
```

---

## 12. Checklist post-setup (validar que todo funciona)

- [ ] `npx tsc --noEmit` pasa sin errores
- [ ] `npx -y vitest run` pasa todos los tests
- [ ] Netlify deploy verde (sin errores)
- [ ] `curl https://TU-SITE.netlify.app/.netlify/functions/health-check` responde 200
- [ ] Supabase Dashboard accesible
- [ ] Panel admin accesible con tu email
- [ ] Primer cliente onboardeado con éxito
- [ ] Primer run procesó al menos 1 factura
- [ ] Sheet del cliente tiene filas
- [ ] Drive del cliente tiene PDF
- [ ] Gmail del cliente tiene label `Facturas/2026`

Si los 11 puntos están ✅, el sistema está operativo.

---

**Fin del documento.** Para issues / decisiones de diseño / proceso reset, ver:
- `docs/ESTADO-2026-06-09.md`
- `docs/PROCESO-AGENTE-FACTURACION.md`
