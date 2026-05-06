# Panel de Control · Equipo de Agentes — Design

**Fecha:** 2026-05-05
**Autor:** Tomás Ramirez Villa (con Claude)
**Status:** Draft — pendiente review del usuario
**Ubicación destino:** `apps/admin/` dentro del monorepo `equipodegentes`

---

## 1. Qué construimos y por qué

Un panel web interno para que **Tomás** (único usuario) supervise y opere
los agentes de la suite `equipodegentes` desplegados en sus clientes.

Hoy hay dos agentes en producción / desarrollo:

- **Equipo-facturación** (TS, Netlify cron diario) — pipeline DIAN
- **Equipo-cartera** (Python, MVP local) — agente cobrador con Claude

Cada agente corre por cliente y guarda su estado en Google Sheets.
**No hay forma centralizada de ver "qué pasó hoy en todos los clientes
con todos los agentes".** Ese es el problema.

### Objetivo del MVP

Que cuando Tomás abra el panel a las 7:30 am pueda:

1. Ver **en una pantalla** si todos los runs de la noche/mañana corrieron OK.
2. **Hacer drill-down** en cualquier fallo y entender la causa sin abrir Netlify.
3. **Re-disparar** un run con un click cuando algo se rompió y ya lo arregló.
4. Ver historial reciente por cliente×agente.

### Fuera de alcance (explícito)

- Login multi-tenant para clientes finales (futuro `apps/customer/`).
- Onboarding self-service de nuevos clientes (futuro).
- Edición rica de prompts/configs en UI (puede venir, pero no MVP).
- Métricas de negocio agregadas tipo "ROI del agente" (futuro).
- Mobile-first. Es desktop. Tomás opera desde laptop.

---

## 2. Audiencia y modelo de uso

- **Único usuario:** Tomás. Login = magic link a `tomasramirezvilla@gmail.com`
  via Supabase Auth (whitelist hardcoded por email).
- **Frecuencia:** 1-2 vistazos al día (mañana cuando termina cron, posible
  triage al mediodía si llegó email de error).
- **Tipo:** "Operations console" — read mostly + acciones puntuales
  (re-disparar, regenerar OAuth, pausar agente para un cliente).

---

## 3. Arquitectura

### 3.1 Big picture

```
┌─────────────────┐  cron diario   ┌──────────────────────┐
│ Equipo-         │ ─────────────▶ │ Netlify Background   │
│ facturación     │                │ Function (worker)    │
│ Equipo-cartera  │                └──────────┬───────────┘
└─────────────────┘                           │
                                              │ al terminar:
                                              │ INSERT agent_runs
                                              ▼
                              ┌─────────────────────────────┐
                              │ Supabase                     │
                              │   tabla `clientes`           │
                              │   tabla `agentes`            │
                              │   tabla `client_agents`      │
                              │   tabla `agent_runs`         │
                              │   tabla `agent_events` (opt) │
                              └──────────────┬───────────────┘
                                             │ SELECT (RLS)
                                             ▼
                              ┌─────────────────────────────┐
                              │ apps/admin/  (Vite+React)    │
                              │  Netlify static deploy       │
                              │  Supabase JS client          │
                              └─────────────────────────────┘
```

### 3.2 Componentes nuevos

1. **Schema Supabase** (`equipodegentes` proyecto, separado del de
   `consultoria-app`). 5 tablas + RLS.
2. **`shared/agents-runtime/`** — paquete TS compartido con un cliente
   Supabase mínimo y la función `recordRun(clientId, agentId, payload)`
   que cada agente llama al final de su corrida.
3. **`apps/admin/`** — la SPA Vite+React+Tailwind.
4. **Netlify edge function `admin-trigger-rerun`** — endpoint pequeño
   que recibe `{ runId }` desde el panel, valida JWT, y dispara la
   background function del agente correspondiente. Necesario porque el
   panel (browser) no puede invocar background functions con secret.

### 3.3 Componentes modificados (mínimo)

- **Equipo-facturación** `agentes/Equipo-facturacion/lib/pipeline.ts`:
  agregar `await recordRun(...)` al inicio (status=running) y al final
  (status=ok|fail + payload con resumen). Se importa de `shared/agents-runtime`.
- **Equipo-cartera** `agentes/equipo-cartera/src/agent.py`: lo mismo,
  pero como Python no puede importar TS, se hace HTTP POST a un endpoint
  Netlify `record-run` (también en `shared/`). Mantiene a Python sin
  acoplarse a Supabase directamente.

---

## 4. Modelo de datos (Supabase)

**Proyecto:** se reutiliza el proyecto Supabase existente de `consultoria-app`
para ahorrar infra. Las tablas del panel de agentes viven en un **schema
dedicado `equipodegentes`**, totalmente aislado de las tablas en `public`
del negocio de consultoría. Cero riesgo de cruce.

Setup manual one-time (Tomás):
1. SQL Editor → `create schema if not exists equipodegentes;`
2. Project Settings → API → Exposed schemas → agregar `equipodegentes`
3. Correr migración `0001_init_equipodegentes.sql` (la creamos en fase 0)

El cliente JS del admin conecta así:
```ts
createClient(url, anonKey, { db: { schema: 'equipodegentes' } })
```

```sql
-- Todas las tablas viven en schema equipodegentes.
set search_path to equipodegentes;

-- Catálogo de clientes (no se confunde con clientes de consultoría;
-- estos son los que tienen agentes desplegados).
create table equipodegentes.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,                       -- "Sin Bata Co.", "La Dentistería"
  slug text unique not null,                  -- "sin-bata", "la-dentisteria" — auto-generado desde nombre, editable
  activo boolean not null default true,
  notas text,                                 -- libre
  created_at timestamptz not null default now()
);

-- Catálogo de agentes (un row por cada agente del monorepo).
create table equipodegentes.agentes (
  id text primary key,                        -- "facturacion", "cartera"
  nombre text not null,                       -- "Equipo-facturación"
  descripcion text,
  cron_default text,                          -- "0 12 * * *"
  activo boolean not null default true
);

-- Pivote: qué agentes tiene activos cada cliente, con su config.
create table equipodegentes.client_agents (
  cliente_id uuid references equipodegentes.clientes(id) on delete cascade,
  agente_id text references equipodegentes.agentes(id) on delete cascade,
  activo boolean not null default true,
  config jsonb not null default '{}',         -- sheet_id, drive_folder, notify_email, etc.
  activated_at timestamptz not null default now(),
  primary key (cliente_id, agente_id)
);

-- Cada corrida de un agente para un cliente.
create table equipodegentes.agent_runs (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  status text not null check (status in ('running','ok','fail','warn')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  triggered_by text not null default 'cron',  -- 'cron' | 'manual' | 'rerun'
  summary text,                                -- "5 facturas, 0 duplicadas"
  payload jsonb,                               -- detalles estructurados
  error_message text,
  error_stack text,
  netlify_log_url text                         -- link directo a Netlify logs
);

create index on equipodegentes.agent_runs (started_at desc);
create index on equipodegentes.agent_runs (cliente_id, agente_id, started_at desc);
create index on equipodegentes.agent_runs (status) where status in ('fail','warn');

-- (Opcional, fase 2) Eventos granulares dentro de un run.
-- Ej: "factura procesada", "préstamo escalado a humano".
create table equipodegentes.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references equipodegentes.agent_runs(id) on delete cascade,
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  tipo text not null,                          -- "factura_procesada", "prestamo_escalado"
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index on equipodegentes.agent_events (run_id);
create index on equipodegentes.agent_events (cliente_id, agente_id, created_at desc);
```

### RLS

- Todas las tablas con RLS activado.
- Una sola policy: `(auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com'`
  permite todo (read+write) en todas las tablas. Cualquier otro JWT → 0 filas.
- Los agentes no escriben con JWT de Tomás — escriben con un **service_role
  key** guardado en env vars de Netlify (bypassea RLS). Ese key NUNCA va al
  bundle del frontend.

---

## 5. Estructura del panel (UI)

### 5.1 Rutas

```
/                       → Home: Matriz Clientes × Agentes (vista por defecto)
/feed                   → Feed cronológico de runs (pestaña secundaria)
/cliente/:slug          → Ficha del cliente (sus agentes, runs, config)
/agente/:id             → Vista del agente (todos los clientes que lo tienen)
/run/:id                → Detalle de un run (drill-down con error + acciones)
/login                  → Magic link
```

### 5.2 Home — Matriz Clientes × Agentes

**Header:** logo + KPIs globales (runs hoy, errores, clientes activos, próximo cron).

**Body:** tabla. Filas = clientes activos. Columnas = agentes activos.
Cada celda muestra el último run del día:

- 🟢 verde: OK
- 🟡 amarillo: WARN (corrió pero con escalados/items pendientes)
- 🔴 rojo: FAIL
- ⚪ gris: agente no activado para ese cliente

Click en celda → `/run/:id` (último run de esa pareja).
Click en cliente → `/cliente/:slug`.
Click en header de agente → `/agente/:id`.

### 5.3 Feed cronológico

Una tabla virtualizada de los últimos 200 runs ordenados por `started_at desc`.
Columnas: hora, agente, cliente, resumen, status. Filtros arriba: cliente,
agente, status, rango de fechas.

### 5.4 Detalle de run (`/run/:id`)

Definida en el mockup ya aprobado. Resumen:

- Breadcrumbs: Panel · Cliente · Agente · Run del fecha
- Status pill, tiempos, trigger
- Grid 2 columnas:
  - Izq: resumen del run + bloque de error (si aplica) con causa probable + fix sugerido
  - Der: historial reciente (últimos 5 runs cliente×agente) + config del agente
- Acciones: **Re-disparar run** (primary), Regenerar OAuth, Pausar agente para
  este cliente, Ver logs Netlify, Editar config (próxima fase)

### 5.5 Ficha de cliente (`/cliente/:slug`)

- Header: nombre, slug, activo desde, contacto
- Lista de agentes activados con su estado actual (mini-matriz vertical)
- Últimos 30 runs del cliente (todos los agentes mezclados, cronológico)
- Bloque de config (jsonb) por agente con UI mínima: ver + abrir editor JSON

### 5.6 Vista de agente (`/agente/:id`)

- Header: nombre, descripción, cron default, status (activo/inactivo)
- Lista de clientes con ese agente activado y su último run
- Stream de runs cross-cliente para ese agente
- Sin acciones de edición de prompts en MVP

---

## 6. Estética / sistema de diseño

Aplica el sistema **interno** ya documentado en memoria:

- **Tipografía:** Fraunces (titulares + ficha de cliente), ui-sans-serif
  (datos tabulares, labels), ui-monospace (errores, IDs).
- **Color:** fondo papel `#f7f2e8`, borde `#e0d6bd`, texto `#2a2620`,
  acento vermellón `#c5443a` (errores, primary action), gris-tierra `#8a7f68`
  (secundarios). Estados: verde `#5a8556`, amarillo `#d4a017`, rojo `#c5443a`.
- **Componentes:** cards con borde sólido fino, sin sombras, divisores
  punteados para historial.
- **Densidad:** alta. Es panel ops, no marketing.

**Importante:** este sistema es el de "Tools/pendientes interno", NO el
de "App EA Consultoria (clientes)". No mezclar con Plus Jakarta + tokens
de la app de consultoría.

---

## 7. Stack y deploy

### 7.1 Frontend

- **Vite 5** + **React 18** + **TypeScript**
- **Tailwind CSS** con `tailwind.config.js` configurando los tokens del
  sistema interno arriba (sin reutilizar el de consultoria-app)
- **@supabase/supabase-js v2** (auth + queries)
- **@tanstack/react-router** (file-based, simple) — alternativa: react-router-dom
- **@tanstack/react-query** para data fetching + cache
- Sin librería de UI: componentes propios pequeños (Tabla, Card, Button,
  Pill). Apunta a ~10 componentes total.

### 7.2 Estructura de carpetas

```
apps/admin/
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
├── index.html
├── netlify.toml                    # publish = "dist"
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── routes/
    │   ├── home.tsx                # matriz
    │   ├── feed.tsx
    │   ├── cliente.$slug.tsx
    │   ├── agente.$id.tsx
    │   ├── run.$id.tsx
    │   └── login.tsx
    ├── components/
    │   ├── Matriz.tsx
    │   ├── Feed.tsx
    │   ├── RunDetail.tsx
    │   ├── Pill.tsx
    │   └── ...
    ├── lib/
    │   ├── supabase.ts             # singleton client
    │   ├── auth.ts                 # magic link helpers
    │   └── queries.ts              # react-query hooks
    └── styles/
        └── globals.css
```

### 7.3 shared/agents-runtime/

```
shared/agents-runtime/
├── package.json
├── src/
│   ├── supabase-server.ts          # client con service_role para agentes TS
│   ├── record-run.ts               # recordRun(...) helper
│   └── index.ts
```

### 7.4 Deploy

- **Un solo sitio Netlify** para todo el monorepo (ya existe).
- `netlify.toml` raíz se modifica para que `apps/admin` se construya con
  `cd apps/admin && npm install && npm run build` y se publique de
  `apps/admin/dist`.
- O alternativa más limpia: **un sitio Netlify nuevo** dedicado a `admin`,
  con su propio `netlify.toml`. Las background functions de los agentes
  (`facturacion-background`, etc.) siguen en el sitio principal donde corren
  los crons. La edge function `admin-trigger-rerun` (sección 8) vive en el
  sitio admin y hace HTTP POST autenticado al sitio principal.
  → **Recomendación: sitio Netlify separado** para admin. Cero riesgo de
     que un build del panel rompa el cron de los agentes.

### 7.5 Variables de entorno

| Var | Dónde | Para qué |
|---|---|---|
| `SUPABASE_URL` | admin build + agentes | endpoint del proyecto |
| `SUPABASE_ANON_KEY` | admin build (público) | cliente del browser |
| `SUPABASE_SERVICE_ROLE_KEY` | netlify env vars (NUNCA en bundle) | escrituras de los agentes |
| `ADMIN_ALLOWED_EMAIL` | admin build | whitelist (`tomasramirezvilla@gmail.com`) |

---

## 8. Re-disparar un run (flujo end-to-end)

1. Tomás click en "Re-disparar run" en `/run/:id`.
2. Frontend `POST /api/admin-trigger-rerun` con `{ runId }` y JWT del usuario.
3. Edge function:
   - Valida JWT vía `supabase.auth.getUser()`.
   - Confirma email en whitelist.
   - Lee `agent_runs` por `runId` para sacar `cliente_id` + `agente_id`.
   - Hace POST autenticado a la background function correspondiente
     (`facturacion-background` o futuro `cartera-background`) con
     `{ clienteId, triggeredBy: 'rerun', originalRunId: runId }`.
4. Background function corre, llama `recordRun(...)` al inicio y final.
5. El frontend hace polling (o usa Supabase Realtime) sobre `agent_runs`
   para ver el nuevo run aparecer.

---

## 9. Plan de implementación por fases

**Fase 0 — Setup (1 sesión)**
- Crear proyecto Supabase nuevo `equipodegentes-prod`.
- Migración `0001_init.sql` con las 5 tablas + RLS + seed mínimo (clientes
  reales, agentes `facturacion` y `cartera`).
- Crear `shared/agents-runtime/` con `recordRun`.

**Fase 1 — Instrumentar agentes (1 sesión)**
- Modificar `Equipo-facturacion/lib/pipeline.ts` para llamar `recordRun`
  al inicio y final de cada corrida.
- Endpoint Netlify `record-run` para que `equipo-cartera` (Python) reporte.
- Validar en Supabase que llegan rows de la próxima corrida del cron.

**Fase 2 — Panel MVP (2 sesiones)**
- `apps/admin/` skeleton + login magic link.
- Home matriz + feed.
- Detalle de run.
- Deploy en Netlify dedicado.

**Fase 3 — Acciones operativas (1 sesión)**
- Edge function `admin-trigger-rerun`.
- Botones de acción en `/run/:id`: re-disparar, pausar agente para cliente.
- Regenerar OAuth → por ahora solo abre instructivo (la regeneración
  real del refresh token Google requiere flow OAuth manual).

**Fase 4 — Polish / nice-to-have (cuando se necesite)**
- Realtime updates (`supabase.channel()` en agent_runs).
- Agent_events: vista granular dentro de un run.
- Editor JSON para `client_agents.config`.
- Dashboard de métricas agregadas.

---

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Doble fuente de verdad: Supabase vs Google Sheets | Sheets sigue siendo la verdad operativa para facturas/cartera. Supabase es **solo metadata de runs**, no duplica datos de negocio. |
| Service role key filtrado | Solo en env vars Netlify, nunca importado en `apps/`. Lint rule + revisión en PR. |
| Magic link a Gmail bloqueado | Por ahora solo `tomasramirezvilla@gmail.com`. Si llega a bloquearse, se agrega un segundo email backup en env vars. |
| Python no puede usar el helper TS | Endpoint Netlify `record-run` HTTP-only. Mismo helper bajo el capó. |
| Cron del agente y record-run desincronizados | `recordRun(status='running')` al inicio + try/finally con `status='ok'\|'fail'`. Si el proceso muere sin registrar fin, queda visible como `running` >5min → mostrar como WARN en panel. |

---

## 11. Cosas que decidimos NO hacer (y por qué)

- **No multi-tenant ahora.** Si en 6 meses los clientes piden ver su propio
  panel, se hace `apps/customer/` separado. No vale complicar este MVP.
- **No Next.js.** Sobra para un panel interno sin SEO. Vite es 10x más simple
  de mantener.
- **No mobile-first.** Tomás opera desde laptop. Se hará responsive básico
  pero no se priorizan layouts mobile.
- **No edición rica de prompts en UI.** Los prompts de cada agente viven
  en su carpeta (`prompts/cobrador_v1.md` etc). Editarlos en UI es un
  rabbit hole. Por ahora, ver y abrir el archivo en el repo.

---

## 12. Decisiones cerradas

- **Email login**: solo `tomasramirezvilla@gmail.com` por ahora. Si Gmail
  bloquea magic links de Supabase, se agrega backup en env var.
- **Proyecto Supabase**: se **reutiliza el proyecto de `consultoria-app`**
  con un schema dedicado `equipodegentes` (ver §4). Tablas existentes en
  `public` no se tocan.
- **Slug de cliente**: auto-generado al onboarding desde el nombre
  (slugify: minúsculas, guiones, sin acentos), editable manual desde la
  ficha del cliente.
