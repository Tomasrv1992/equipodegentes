# Setup para un nuevo desarrollador (clon desde cero)

> Esta guía es para alguien que **nunca trabajó en este proyecto** y quiere
> levantarlo en su entorno local + producción. Por ejemplo: el hermano de
> Tomás, un nuevo dev que se suma, o tú mismo en una máquina nueva.

---

## ¿Qué es Operatto?

Suite de agentes automatizados para PyMEs colombianas. El primer agente
("Equipo-facturación") procesa facturas DIAN automáticamente:

1. Lee el Gmail del cliente
2. Detecta facturas DIAN (ZIP+XML), Word (.docx), PDFs (Stripe/AWS/etc)
3. Las clasifica por categoría contable colombiana
4. Extrae retenciones (ReteFuente / ReteIVA / ReteICA) del XML
5. Aplica reglas de retención del cliente (de oficio si XML vacío)
6. Sube archivos organizados a Drive (carpetas por mes)
7. Llena un Google Sheet con cada factura
8. Manda email diario al cliente con resumen
9. Todo cargado a Supabase para el panel admin

Hay un **panel admin** (Vite + React) donde el owner ve métricas de todos
los clientes, configura responsabilidades tributarias, etc.

---

## Stack

| Capa | Tecnología |
|---|---|
| **Frontend admin** | Vite + React 18 + TypeScript + Tailwind |
| **Backend cron** | Netlify Functions (Node.js, esbuild) |
| **OAuth + APIs cliente** | Netlify Edge Functions (Deno) |
| **DB + Auth** | Supabase (Postgres + RLS + Auth) |
| **Email** | Resend |
| **LLM** | Anthropic Claude Haiku (extracción Word/PDF) |
| **Hosting** | Netlify (2 sitios: cron + admin) |

---

## Paso 1 — Clonar y deps locales

```bash
git clone https://github.com/Tomasrv1992/equipodegentes.git
cd equipodegentes
git checkout feat/admin-panel    # branch de producción
npm install
npm test                         # verificar que pasan 31 tests
npm run typecheck                # type check del monorepo
```

---

## Paso 2 — Servicios externos (crear cuentas)

### 2.1 — Supabase

1. Crear proyecto en https://supabase.com
2. Activar extensión `pgcrypto` (Settings → Database → Extensions)
3. Correr las **7 migraciones SQL** en orden, una por una:
   - `docs/superpowers/migrations/0001_init_equipodegentes.sql`
   - `0002_client_credentials_and_onboarding.sql`
   - `0003_first_run_backfill.sql`
   - `0004_fix_onboarding_lookup_completed.sql`
   - `0005_unique_factura_event.sql`
   - `0006_migrate_owner_to_multitenant.sql` *(opcional — para migrar cron legacy)*
   - `0007_retention_rules.sql`
4. En Auth → Providers → activar "Email" (magic link)
5. Anotar: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`

### 2.2 — Google Cloud

1. Crear proyecto en https://console.cloud.google.com
2. Habilitar APIs: Gmail API, Drive API, Sheets API, OAuth2 People API
3. OAuth consent screen:
   - Tipo: External
   - Modo: Testing (suficiente para hasta 100 usuarios test)
   - Scopes: agregar `gmail.modify`, `drive`, `spreadsheets`, `userinfo.email`
   - Test users: agregar tu email + los emails de tus clientes test
4. Credenciales → Crear OAuth 2.0 Client ID:
   - Tipo: Web application
   - Authorized redirect URI: `https://TU-ADMIN-SITE.netlify.app/api/auth/google/callback`
5. Anotar: `GOOGLE_OAUTH_WEB_CLIENT_ID`, `GOOGLE_OAUTH_WEB_CLIENT_SECRET`

### 2.3 — Anthropic

1. https://console.anthropic.com → Sign up
2. Settings → Billing → cargar **$5 USD mínimo**
3. Settings → API Keys → Create Key
4. Anotar: `ANTHROPIC_API_KEY` (empieza con `sk-ant-...`)

### 2.4 — Resend

1. https://resend.com → Sign up
2. Domains → Add → poner tu dominio (ej: `operatto.co`)
3. Agregar los 4 DNS records que te muestra Resend en tu registrador (Namecheap,
   GoDaddy, etc). Esperar 5-30 min hasta que diga "Verified".
4. API Keys → Create
5. Anotar: `RESEND_API_KEY`

### 2.5 — Netlify (2 sitios)

1. https://app.netlify.com → New site → Import from Git
2. **Sitio 1: cron**
   - Repo: `equipodegentes`, branch: `feat/admin-panel`
   - Base directory: (vacío)
   - Build command: `npm install`
   - Publish directory: `public`
3. **Sitio 2: admin**
   - Mismo repo, mismo branch
   - Base directory: `apps/admin`
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`

---

## Paso 3 — Configurar env vars en Netlify

Para cada sitio, ir a Site configuration → Environment variables y pegar los
valores correspondientes del archivo `.env.sample` (en la raíz del repo).

### Sitio "cron" necesita:
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_VAULT_KEY,
FACTURACION_INTERNAL_SECRET, GOOGLE_OAUTH_WEB_CLIENT_ID,
GOOGLE_OAUTH_WEB_CLIENT_SECRET, RESEND_API_KEY, NOTIFY_EMAIL_FROM,
NOTIFY_EMAIL_TO, ANTHROPIC_API_KEY
```

### Sitio "admin" necesita:
```
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
CREDENTIALS_VAULT_KEY, GOOGLE_OAUTH_WEB_CLIENT_ID,
GOOGLE_OAUTH_WEB_CLIENT_SECRET, FACTURACION_INTERNAL_SECRET,
MAIN_SITE_URL (URL del cron), ADMIN_SITE_URL (URL de este sitio),
ADMIN_ALLOWED_EMAIL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
VITE_ADMIN_ALLOWED_EMAIL
```

Generar `CREDENTIALS_VAULT_KEY` y `FACTURACION_INTERNAL_SECRET` con:
```bash
openssl rand -hex 32
```
Usar el **mismo valor** en los 2 sitios.

---

## Paso 4 — Trigger deploys

1. En cada sitio Netlify → Deploys → Trigger deploy → **Clear cache and deploy**
2. Esperar ~2-3 min hasta "Published"

---

## Paso 5 — Crear primer cliente (vos mismo como test)

1. Abrir `https://TU-ADMIN.netlify.app`
2. Login con magic link (el email que pusiste en `ADMIN_ALLOWED_EMAIL`)
3. Click "+ Nuevo cliente" → nombre + slug → activar Equipo-facturación
4. En la ficha del cliente → "Crear link de onboarding"
5. Abrí el link en **modo incógnito**
6. Conectar Google con una cuenta de prueba
7. Operatto auto-crea folder Drive + Sheet en esa cuenta
8. Disparar primer run (o esperar cron diario 7am Bogotá)

---

## Paso 6 — Verificar

Después del primer run del cliente:

1. **Panel admin** → KPIs con facturas procesadas
2. **Sheet del cliente** → pestañas Enero..Diciembre + Dashboard con métricas vivas
3. **Drive del cliente** → carpetas YYYY-MM con PDFs
4. **Email del cliente** → desde `noreply@tudominio.com` con resumen

---

## Estructura del repo

```
equipodegentes/
├── agentes/Equipo-facturacion/
│   ├── lib/
│   │   ├── pipeline.ts                 # Core: procesa email → Drive/Sheet
│   │   ├── retenciones-engine.ts       # Reglas de retención por cliente
│   │   ├── retenciones-constants.ts    # UVT, tarifas RTF, tarifas ICA
│   │   ├── llm-extractor.ts            # Claude para Word/PDF no-DIAN
│   │   ├── llm-pre-filters.ts          # Anti-cost filters
│   │   ├── doc-parsers.ts              # mammoth (Word) + pdf-parse
│   │   ├── categorizacion-reglas.json  # Categoría por NIT/keyword
│   │   └── __tests__/                  # 20 tests del engine
│   └── scripts/                        # CLI locales (procesar, diagnostico)
│
├── apps/admin/                         # Panel (Vite + React)
│   ├── src/
│   │   ├── components/                 # ClienteFicha, AgenteFicha, Matriz, etc
│   │   ├── routes/                     # /cliente/:slug, /run/:id, etc
│   │   └── lib/                        # queries, metrics, supabase client
│   └── netlify/edge-functions/         # OAuth callback, admin APIs
│
├── shared/agents-runtime/              # Compartido entre agentes
│   └── src/                            # credentials, events, supabase server
│
├── netlify/functions/                  # Background fns (cron site)
│   ├── facturacion-background.mts      # El que procesa
│   ├── facturacion-cron.mts            # Scheduled stub 7am Bogotá
│   ├── backfill-events-from-sheet.mts  # Backfill manual
│   └── health-check.mts                # Compara Gmail/Drive/Sheet/events
│
└── docs/
    ├── ROADMAP-OPERATTO.md             # Pendientes priorizados
    ├── superpowers/migrations/         # SQL 0001-0007
    └── SETUP-NUEVO-DESARROLLADOR.md    # Este archivo
```

---

## Comandos útiles

```bash
# Tests
npm test

# Type check completo
npm run typecheck

# Type check solo del admin
cd apps/admin && npx tsc --noEmit

# Build local del admin
cd apps/admin && npm run build

# Validar bundle del cron sin deployar
npx esbuild netlify/functions/facturacion-background.mts \
  --bundle --platform=node --target=node18 --format=esm \
  --external:@netlify/functions --outfile=/tmp/test.mjs
```

---

## Próximos pasos / Pendientes

Ver `docs/ROADMAP-OPERATTO.md`. En orden de prioridad:

1. **Wizard onboarding de retenciones** — preguntar al cliente en el flow de
   onboarding sus responsabilidades (RTF/IVA/ICA, municipio) para auto-configurar.
2. **Backfill silencioso** — actualizar Sheets viejos con retenciones de facturas
   ya procesadas (sin enviar emails).
3. **Email body parser** — extraer datos de recibos sin adjunto (Notion, GitHub
   confirmaciones de pago).
4. **Email mensual automático del resumen al cliente**.
5. **Verificación de Google** (cuando llegues a 20+ clientes — actualmente en
   Testing mode con límite de 100 usuarios).

---

## Glosario rápido

- **DIAN**: Dirección de Impuestos de Colombia. Las facturas electrónicas oficiales
  vienen como ZIP con un XML estructurado siguiendo el estándar UBL.
- **NIT**: número de identificación tributaria de empresas/personas.
- **RTF / ReteFuente**: Retención en la Fuente (anticipo de renta del proveedor).
- **ReteIVA**: Retención del IVA facturado.
- **ReteICA**: Retención de Industria y Comercio (municipal).
- **UVT**: Unidad de Valor Tributario, actualizada cada año por la DIAN.
  Define cuantías mínimas (ej: facturas < 4 UVT no se retienen).
- **Cuenta de cobro**: documento Word de proveedores no obligados a facturar
  electrónicamente (personas naturales, contratistas).
