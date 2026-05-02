# Agente: Control de Facturación DIAN

Pipeline automático que lee Gmail, encuentra facturas electrónicas DIAN
(formato Colombia: ZIP con PDF + XML UBL 2.1), las organiza en Drive por mes,
registra cada una en Google Sheets, y manda email diario con el resumen.

## Cómo corre en producción

```
Netlify Scheduled Function (0 12 * * * UTC = 7am Bogotá)
   ↓ POST con secret
Netlify Background Function (lee del agente)
   ↓
agentes/facturacion/lib/pipeline.ts (lógica core)
   ↓
Gmail API + Drive API + Sheets API
```

## Archivos

| Path | Qué es |
|---|---|
| `lib/pipeline.ts` | Lógica core del agente. Compartida entre el cron de Netlify y el CLI local. |
| `scripts/procesar-facturas.ts` | CLI wrapper para corridas manuales. |
| `scripts/setup-oauth.mjs` | One-time bootstrap del refresh token Google. |
| `scripts/diagnostico-facturas.ts` | Snapshot del estado (filas Sheet, archivos Drive, labels Gmail). |
| `scripts/crear-dashboard.ts` | One-time: crea pestaña "Dashboard" con métricas vivas en el Sheets. |
| `.env.local.example` | Template de variables de entorno. |

Las functions de Netlify viven en `../../netlify/functions/`:
- `facturacion-cron.mts` — scheduled stub
- `facturacion-background.mts` — worker (15min timeout)

## Variables de entorno

Ver `.env.local.example`. Resumen:

| Var | Para qué |
|---|---|
| `GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | OAuth Google (Gmail + Drive + Sheets) |
| `INVOICES_DRIVE_FOLDER_ID` | Carpeta padre donde crear `YYYY-MM/` por mes |
| `INVOICES_SHEET_ID` + `INVOICES_SHEET_TAB` | Sheet de control + nombre de pestaña |
| `RESEND_API_KEY` | Para email diario (free tier resend.com, 100/día) |
| `NOTIFY_EMAIL_TO` | Destinatario del resumen |
| `FACTURACION_INTERNAL_SECRET` | Solo en Netlify env vars — auth interna entre cron y bg fn |

## Comandos

Desde la raíz del monorepo (`equipodegentes/`):

```bash
npm run facturacion:dry-run      # ver qué hay sin tocar
npm run facturacion:procesar     # corrida real
npm run facturacion:diagnostico  # snapshot estado
npm run facturacion:setup-oauth  # regenerar refresh token
```

O desde `agentes/facturacion/` directamente:

```bash
npm run dry-run
npm run procesar
npm run diagnostico
npm run setup-oauth
```

## Setup OAuth (paso a paso)

Ver el setup completo en docs (próximamente migrado). Resumen:

1. https://console.cloud.google.com → Crear proyecto
2. Habilitar Gmail API + Drive API + Sheets API
3. OAuth consent screen → External → agregar tu email como test user
4. Crear OAuth Client ID tipo **Desktop app** → copiar Client ID + Secret
5. Pegar en `.env.local` (CLIENT_ID, CLIENT_SECRET)
6. Correr `npm run setup-oauth` → autorizar en browser → copiar el refresh token al `.env.local`

## Idempotencia

- Primary: label `Procesado` en Gmail (lo aplica el script al terminar cada email).
- Secondary: dup-check por N° factura + NIT en el Sheet antes de insertar.

Si ves un correo con label `Procesado` pero sin estar en el Sheet, hubo error a mitad y el siguiente run lo reintenta (al quitarle el label).

## Trampas conocidas

- ⚠️ El value de `GOOGLE_OAUTH_REFRESH_TOKEN` en Netlify env vars debe empezar
  con `1//`, NO con `=1//`. Es fácil pegar el `=` al copiar de la terminal.
  Causa `invalid_grant` silencioso.

- 📅 Para fechas, **siempre** usar `IssueDate` del XML, NUNCA el header `Date`
  del email. Los correos reenviados (vía Apps Script desde otro Gmail) tienen
  header Date = fecha del forward, no de la factura.

## Pendientes hacia multi-tenant

El código ya acepta `customerId` opcional en el body de la background fn
(spec `docs/superpowers/specs/2026-04-29-procesar-facturas-autonomy-design.md` §4.5).
Cuando se haga el spin-off real al SaaS:
1. Tabla `customers` en Supabase con credenciales por cliente
2. La rama `customerId !== undefined` lee de Supabase en vez de env vars
3. Cron itera sobre `customers` activos y dispara N background fns en paralelo
