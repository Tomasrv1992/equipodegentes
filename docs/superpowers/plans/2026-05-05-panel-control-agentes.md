# Panel de Control · Equipo de Agentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir el panel admin interno (`apps/admin/`) que Tomás usa para supervisar y operar los agentes (`facturación`, `cartera`) desplegados en sus clientes — con dashboard matriz, drill-down de runs, y acciones operativas (re-disparar).

**Architecture:** Agentes escriben metadata de cada corrida a Supabase (schema dedicado `equipodegentes`). Una SPA Vite+React lee de Supabase con cliente JS (RLS por email whitelisted). Re-disparar usa una edge function que invoca la background function del agente correspondiente.

**Tech Stack:**
- Frontend: Vite 5 + React 18 + TypeScript + Tailwind CSS + react-router-dom + @tanstack/react-query + @supabase/supabase-js
- Backend (existing): Netlify Functions (TS) + Python 3.14 (cartera)
- DB: Supabase (schema `equipodegentes` en proyecto compartido con consultoria-app)
- Tests: Vitest para lógica TS pura
- Deploy: Sitio Netlify dedicado para `apps/admin`

**Spec:** [docs/superpowers/specs/2026-05-05-panel-control-agentes-design.md](../specs/2026-05-05-panel-control-agentes-design.md)

---

## File Structure

Archivos creados o modificados, agrupados por responsabilidad.

### Nuevos archivos en `equipodegentes/`

```
docs/superpowers/migrations/
└── 0001_init_equipodegentes.sql              # SQL completo schema + RLS

shared/agents-runtime/
├── package.json                              # nuevo workspace package
├── tsconfig.json
├── src/
│   ├── index.ts                              # re-exports
│   ├── supabase-server.ts                    # client con service_role
│   ├── record-run.ts                         # helper recordRun()
│   └── slugify.ts                            # helper para slugs
└── src/__tests__/
    ├── record-run.test.ts
    └── slugify.test.ts

netlify/functions/
├── record-run.mts                            # endpoint HTTP para Python u otros runtimes
└── admin-trigger-rerun.mts                   # endpoint que dispara re-run autenticado

apps/admin/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── netlify.toml                              # publish = "dist"
├── .env.example
└── src/
    ├── main.tsx                              # entrypoint
    ├── App.tsx                               # router shell
    ├── lib/
    │   ├── supabase.ts                       # cliente con schema=equipodegentes
    │   ├── auth.ts                           # helpers magic link
    │   ├── queries.ts                        # react-query hooks
    │   └── classify-error.ts                 # causa probable + fix sugerido
    ├── components/
    │   ├── Layout.tsx
    │   ├── Pill.tsx
    │   ├── Matriz.tsx
    │   ├── Feed.tsx
    │   ├── RunDetail.tsx
    │   ├── ClienteFicha.tsx
    │   ├── AgenteFicha.tsx
    │   └── LoginGate.tsx
    ├── routes/
    │   ├── home.tsx
    │   ├── feed.tsx
    │   ├── cliente.tsx
    │   ├── agente.tsx
    │   ├── run.tsx
    │   └── login.tsx
    ├── types.ts                              # types DB
    └── styles/
        └── globals.css                       # Tailwind + tokens internos
```

### Archivos modificados

```
.gitignore                                    # agregar apps/admin/.env*
netlify/functions/facturacion-background.mts  # llamar recordRun() inicio + fin
agentes/equipo-cartera/src/agent.py           # POST a /record-run al final
package.json (root)                           # agregar shared/agents-runtime al workspaces
```

---

## Pre-tareas — Acciones manuales del Tomás (anti-bobos)

Estas son cosas que **yo no puedo hacer por ti** (requieren browser + tu cuenta). Las agrupé al inicio porque las necesito completas antes de las tareas que dependen de ellas. Cada una ~3 minutos.

> Marca cada checkbox cuando lo termines.

### P1. Crear schema `equipodegentes` en Supabase

- [ ] Abrir el dashboard del proyecto Supabase de `consultoria-app` (el que ya usas)
- [ ] Ir a **SQL Editor** → **New query**
- [ ] Pegar y correr:
  ```sql
  create schema if not exists equipodegentes;
  ```
- [ ] Confirmar que dice "Success. No rows returned"

### P2. Exponer el schema en la API de Supabase

- [ ] Ir a **Project Settings** (⚙️ abajo a la izquierda) → **API**
- [ ] Buscar la sección **Exposed schemas**
- [ ] Agregar `equipodegentes` a la lista (separado por coma del `public` que ya está)
- [ ] Click **Save**

### P3. Copiar credenciales que vamos a necesitar

- [ ] En el mismo **Project Settings → API**, copiar a un archivo temporal estos 3 valores:
  - `Project URL` (ej: `https://abcd.supabase.co`)
  - `anon public` key (la pública, va al frontend)
  - `service_role` key (la secreta, NUNCA va al frontend — solo a env vars de Netlify)

### P4. Crear sitio Netlify dedicado para `apps/admin`

- [ ] Abrir https://app.netlify.com
- [ ] Click **Add new site → Import an existing project**
- [ ] Conectar el repo `equipodegentes` (mismo del que ya tienes el sitio principal)
- [ ] **Configuración del build (importante)**:
  - Base directory: `apps/admin`
  - Build command: `npm install && npm run build`
  - Publish directory: `apps/admin/dist`
- [ ] Site name: `equipodegentes-admin` (o el que prefieras)
- [ ] **NO hacer deploy todavía** (vas a configurar env vars primero)

### P5. Configurar Auth en Supabase

- [ ] Dashboard Supabase → **Authentication** → **Providers**
- [ ] Confirmar que **Email** está habilitado
- [ ] Authentication → **URL Configuration**
- [ ] **Site URL**: `https://equipodegentes-admin.netlify.app` (o el dominio del sitio P4)
- [ ] **Redirect URLs**: agregar `http://localhost:5173/auth/callback` (para dev local) y `https://equipodegentes-admin.netlify.app/auth/callback`

> ⚠️ Si alguno de estos pasos falla, escribime el error exacto y seguimos. **No avances** a la Fase 0 sin completar P1-P5.

---

## Fase 0 — Foundation (Supabase schema + helper compartido)

### Task 0.1: Migración SQL completa

**Files:**
- Create: `docs/superpowers/migrations/0001_init_equipodegentes.sql`

- [ ] **Step 1: Crear el archivo SQL con todo el schema, RLS y seed**

```sql
-- 0001_init_equipodegentes.sql
-- Crea todas las tablas del panel admin en el schema equipodegentes.
-- Asume que el schema ya existe (ver pre-tarea P1).

-- ===== Tablas =====

create table equipodegentes.clientes (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  slug text unique not null,
  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now()
);

create table equipodegentes.agentes (
  id text primary key,
  nombre text not null,
  descripcion text,
  cron_default text,
  activo boolean not null default true
);

create table equipodegentes.client_agents (
  cliente_id uuid references equipodegentes.clientes(id) on delete cascade,
  agente_id text references equipodegentes.agentes(id) on delete cascade,
  activo boolean not null default true,
  config jsonb not null default '{}',
  activated_at timestamptz not null default now(),
  primary key (cliente_id, agente_id)
);

create table equipodegentes.agent_runs (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  status text not null check (status in ('running','ok','fail','warn')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int,
  triggered_by text not null default 'cron',
  summary text,
  payload jsonb,
  error_message text,
  error_stack text,
  netlify_log_url text
);

create index agent_runs_started_at_idx
  on equipodegentes.agent_runs (started_at desc);
create index agent_runs_cliente_agente_started_idx
  on equipodegentes.agent_runs (cliente_id, agente_id, started_at desc);
create index agent_runs_problem_idx
  on equipodegentes.agent_runs (status)
  where status in ('fail','warn');

create table equipodegentes.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references equipodegentes.agent_runs(id) on delete cascade,
  cliente_id uuid not null references equipodegentes.clientes(id),
  agente_id text not null references equipodegentes.agentes(id),
  tipo text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index agent_events_run_idx on equipodegentes.agent_events (run_id);
create index agent_events_cliente_agente_idx
  on equipodegentes.agent_events (cliente_id, agente_id, created_at desc);

-- ===== RLS =====

alter table equipodegentes.clientes        enable row level security;
alter table equipodegentes.agentes         enable row level security;
alter table equipodegentes.client_agents   enable row level security;
alter table equipodegentes.agent_runs      enable row level security;
alter table equipodegentes.agent_events    enable row level security;

-- Policy única: solo el email whitelisted puede leer/escribir.
-- Service role key (que usan los agentes desde Netlify) bypassea RLS.
create policy "tomas_only" on equipodegentes.clientes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agentes
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.client_agents
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agent_runs
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
create policy "tomas_only" on equipodegentes.agent_events
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');

-- ===== Seed de catálogo =====

insert into equipodegentes.agentes (id, nombre, descripcion, cron_default, activo) values
  ('facturacion', 'Equipo-facturación',
   'Pipeline DIAN: Gmail → Drive → Sheets',
   '0 12 * * *', true),
  ('cartera',     'Equipo-cartera',
   'Agente cobrador con Claude (MVP local)',
   null, true);

-- Seed de clientes mínimo (los reemplazas con UPDATE después).
insert into equipodegentes.clientes (nombre, slug) values
  ('Owner (Tomás)', 'owner');

-- Activamos facturación para el owner (caso single-tenant actual).
insert into equipodegentes.client_agents (cliente_id, agente_id, config)
select c.id, 'facturacion', '{"sheet_id":"placeholder","drive_folder":"placeholder"}'::jsonb
from equipodegentes.clientes c where c.slug = 'owner';
```

- [ ] **Step 2: Correr la migración manualmente en Supabase SQL Editor**

Acción manual del Tomás: copiar todo el SQL del Step 1, pegarlo en SQL Editor → Run. Esperar "Success".

Verificar:
```sql
select count(*) from equipodegentes.clientes;  -- debe ser 1
select count(*) from equipodegentes.agentes;   -- debe ser 2
```

- [ ] **Step 3: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add docs/superpowers/migrations/0001_init_equipodegentes.sql
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): supabase schema equipodegentes (migration 0001)"
```

---

### Task 0.2: Crear workspace `shared/agents-runtime`

**Files:**
- Create: `shared/agents-runtime/package.json`
- Create: `shared/agents-runtime/tsconfig.json`
- Create: `shared/agents-runtime/src/index.ts`
- Modify: root `package.json` (agregar al workspaces — ya está incluido `shared/*`, verificar)

- [ ] **Step 1: Crear `shared/agents-runtime/package.json`**

```json
{
  "name": "@equipodegentes/agents-runtime",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0"
  },
  "devDependencies": {
    "vitest": "^2.0.0",
    "@types/node": "^22"
  }
}
```

- [ ] **Step 2: Crear `shared/agents-runtime/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "lib": ["ES2022"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Crear `shared/agents-runtime/src/index.ts` (placeholder de exports)**

```ts
export { recordRun, recordRunStart, recordRunEnd } from "./record-run";
export { slugify } from "./slugify";
export { getServerClient } from "./supabase-server";
export type { RecordRunStartInput, RecordRunEndInput } from "./record-run";
```

- [ ] **Step 4: Verificar que el workspace ya está incluido**

Run: `cat c:/Users/TOMAS/Desktop/equipodegentes/package.json | grep -A 5 workspaces`
Expected: ver `"shared/*"` en la lista. Si no, agregarlo.

- [ ] **Step 5: Instalar dependencias**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
npm install
```

Expected: `@supabase/supabase-js` y `vitest` aparecen en `node_modules/`.

- [ ] **Step 6: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add shared/agents-runtime/package.json shared/agents-runtime/tsconfig.json shared/agents-runtime/src/index.ts package-lock.json
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(shared): scaffold agents-runtime workspace"
```

---

### Task 0.3: `slugify` helper con tests

**Files:**
- Create: `shared/agents-runtime/src/slugify.ts`
- Create: `shared/agents-runtime/src/__tests__/slugify.test.ts`

- [ ] **Step 1: Escribir el test que falla**

`shared/agents-runtime/src/__tests__/slugify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { slugify } from "../slugify";

describe("slugify", () => {
  it("convierte a minúsculas y reemplaza espacios por guiones", () => {
    expect(slugify("Sin Bata Co.")).toBe("sin-bata-co");
  });

  it("quita acentos", () => {
    expect(slugify("La Dentistería")).toBe("la-dentisteria");
  });

  it("colapsa múltiples separadores", () => {
    expect(slugify("Foo   --   Bar")).toBe("foo-bar");
  });

  it("recorta guiones de los extremos", () => {
    expect(slugify("  -hello-  ")).toBe("hello");
  });

  it("ignora caracteres no alfanuméricos", () => {
    expect(slugify("Hello, World! 123")).toBe("hello-world-123");
  });

  it("retorna string vacío para input vacío", () => {
    expect(slugify("")).toBe("");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/shared/agents-runtime
npx vitest run src/__tests__/slugify.test.ts
```

Expected: FAIL — "Cannot find module '../slugify'".

- [ ] **Step 3: Implementar `slugify`**

`shared/agents-runtime/src/slugify.ts`:

```ts
/**
 * Convierte un nombre arbitrario en un slug URL-friendly.
 * Ej: "Sin Bata Co." → "sin-bata-co", "La Dentistería" → "la-dentisteria".
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar diacríticos combinantes (U+0300..U+036F)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // no-alfanum → guión
    .replace(/^-+|-+$/g, "");        // recortar guiones extremos
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
npx vitest run src/__tests__/slugify.test.ts
```

Expected: PASS — los 6 tests verdes.

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add shared/agents-runtime/src/slugify.ts shared/agents-runtime/src/__tests__/slugify.test.ts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(shared): slugify helper con tests"
```

---

### Task 0.4: Cliente Supabase server-side

**Files:**
- Create: `shared/agents-runtime/src/supabase-server.ts`

- [ ] **Step 1: Implementar el cliente con service_role**

`shared/agents-runtime/src/supabase-server.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Cliente Supabase con service_role key — bypassea RLS.
 * USAR SOLO desde código server-side (Netlify functions, scripts).
 * Nunca importar desde apps/admin/.
 */
export function getServerClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error("Falta env var SUPABASE_URL");
  if (!key) throw new Error("Falta env var SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "equipodegentes" },
  });

  return cached;
}
```

- [ ] **Step 2: Verificar typecheck del workspace**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
npm run typecheck
```

Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add shared/agents-runtime/src/supabase-server.ts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(shared): supabase server client (service_role)"
```

---

### Task 0.5: Helper `recordRun` con tests

**Files:**
- Create: `shared/agents-runtime/src/record-run.ts`
- Create: `shared/agents-runtime/src/__tests__/record-run.test.ts`

- [ ] **Step 1: Escribir tests con mock de Supabase**

`shared/agents-runtime/src/__tests__/record-run.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordRunStart, recordRunEnd } from "../record-run";

// Mock de getServerClient
vi.mock("../supabase-server", () => {
  const mockSelect = vi.fn();
  const mockInsert = vi.fn(() => ({ select: mockSelect }));
  const mockUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ select: mockSelect })) }));
  const mockFrom = vi.fn(() => ({ insert: mockInsert, update: mockUpdate }));

  return {
    getServerClient: () => ({ from: mockFrom }),
    __mocks: { mockFrom, mockInsert, mockUpdate, mockSelect },
  };
});

import * as serverModule from "../supabase-server";
const mocks = (serverModule as any).__mocks;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordRunStart", () => {
  it("inserta una fila con status=running y devuelve el run_id", async () => {
    mocks.mockSelect.mockResolvedValue({
      data: [{ id: "abc-123" }],
      error: null,
    });

    const id = await recordRunStart({
      clienteSlug: "owner",
      agenteId: "facturacion",
      triggeredBy: "cron",
    });

    expect(id).toBe("abc-123");
    expect(mocks.mockFrom).toHaveBeenCalledWith("agent_runs");
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        agente_id: "facturacion",
        status: "running",
        triggered_by: "cron",
      })
    );
  });

  it("throws si Supabase devuelve error", async () => {
    mocks.mockSelect.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    await expect(
      recordRunStart({ clienteSlug: "owner", agenteId: "facturacion" })
    ).rejects.toThrow("boom");
  });
});

describe("recordRunEnd", () => {
  it("actualiza la fila con status=ok y duration_ms", async () => {
    mocks.mockSelect.mockResolvedValue({ data: [{}], error: null });

    await recordRunEnd({
      runId: "abc-123",
      status: "ok",
      summary: "5 facturas",
      durationMs: 1234,
    });

    expect(mocks.mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        summary: "5 facturas",
        duration_ms: 1234,
      })
    );
  });

  it("guarda error_message + stack cuando status=fail", async () => {
    mocks.mockSelect.mockResolvedValue({ data: [{}], error: null });

    await recordRunEnd({
      runId: "abc-123",
      status: "fail",
      durationMs: 100,
      error: new Error("invalid_grant"),
    });

    expect(mocks.mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "fail",
        error_message: "invalid_grant",
        error_stack: expect.stringContaining("Error: invalid_grant"),
      })
    );
  });
});
```

- [ ] **Step 2: Correr tests, verificar que fallan**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/shared/agents-runtime
npx vitest run src/__tests__/record-run.test.ts
```

Expected: FAIL — "Cannot find module '../record-run'".

- [ ] **Step 3: Implementar `record-run.ts`**

`shared/agents-runtime/src/record-run.ts`:

```ts
import { getServerClient } from "./supabase-server";

export type RunStatus = "running" | "ok" | "fail" | "warn";
export type TriggeredBy = "cron" | "manual" | "rerun";

export interface RecordRunStartInput {
  clienteSlug: string;
  agenteId: string;
  triggeredBy?: TriggeredBy;
}

export interface RecordRunEndInput {
  runId: string;
  status: "ok" | "fail" | "warn";
  durationMs: number;
  summary?: string;
  payload?: unknown;
  error?: Error | { message: string; stack?: string };
  netlifyLogUrl?: string;
}

/**
 * Registra el inicio de un run. Inserta una fila en agent_runs con status='running'
 * y devuelve el id del run para que recordRunEnd lo actualice al terminar.
 */
export async function recordRunStart(input: RecordRunStartInput): Promise<string> {
  const supa = getServerClient();

  const { data: cliente, error: errCli } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", input.clienteSlug)
    .single();

  if (errCli || !cliente) {
    throw new Error(
      `Cliente con slug "${input.clienteSlug}" no encontrado: ${errCli?.message ?? "no rows"}`
    );
  }

  const { data, error } = await supa
    .from("agent_runs")
    .insert({
      cliente_id: cliente.id,
      agente_id: input.agenteId,
      status: "running",
      started_at: new Date().toISOString(),
      triggered_by: input.triggeredBy ?? "cron",
    })
    .select("id");

  if (error || !data || data.length === 0) {
    throw new Error(error?.message ?? "insert agent_runs devolvió 0 rows");
  }

  return data[0].id as string;
}

/**
 * Registra el fin de un run (ok | fail | warn) y actualiza duration + summary.
 */
export async function recordRunEnd(input: RecordRunEndInput): Promise<void> {
  const supa = getServerClient();

  const update: Record<string, unknown> = {
    status: input.status,
    finished_at: new Date().toISOString(),
    duration_ms: input.durationMs,
    summary: input.summary ?? null,
    payload: input.payload ?? null,
    netlify_log_url: input.netlifyLogUrl ?? null,
  };

  if (input.error) {
    update.error_message = input.error.message;
    update.error_stack = "stack" in input.error ? input.error.stack : undefined;
  }

  const { error } = await supa
    .from("agent_runs")
    .update(update)
    .eq("id", input.runId)
    .select("id");

  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Wrapper conveniente: corre `fn`, registra inicio + fin con manejo de errores.
 */
export async function recordRun<T>(
  meta: RecordRunStartInput,
  fn: () => Promise<{ summary?: string; payload?: unknown; result: T }>
): Promise<T> {
  const startedAt = Date.now();
  const runId = await recordRunStart(meta);
  try {
    const { summary, payload, result } = await fn();
    await recordRunEnd({
      runId,
      status: "ok",
      durationMs: Date.now() - startedAt,
      summary,
      payload,
    });
    return result;
  } catch (err: any) {
    await recordRunEnd({
      runId,
      status: "fail",
      durationMs: Date.now() - startedAt,
      error: err,
    });
    throw err;
  }
}
```

- [ ] **Step 4: Correr tests, verificar que pasan**

```bash
npx vitest run src/__tests__/record-run.test.ts
```

Expected: PASS — los 4 tests verdes.

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add shared/agents-runtime/src/record-run.ts shared/agents-runtime/src/__tests__/record-run.test.ts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(shared): recordRun helpers con tests"
```

---

## Fase 1 — Instrumentar agentes existentes

### Task 1.1: Instrumentar `facturacion-background.mts`

**Files:**
- Modify: `netlify/functions/facturacion-background.mts:46-93`

- [ ] **Step 1: Importar `recordRun` helpers**

En `netlify/functions/facturacion-background.mts`, después del import existente de `pipeline`:

```ts
import {
  recordRunStart,
  recordRunEnd,
} from "../../shared/agents-runtime/src/record-run";
```

- [ ] **Step 2: Envolver la ejecución del pipeline con record-run**

Reemplazar las líneas 46-93 (el bloque que arranca con `// 4. Ejecutar pipeline`) por:

```ts
  // 4. Ejecutar pipeline + registrar en agent_runs
  const startedAt = Date.now();
  const clienteSlug = body.customerId ?? "owner";

  let runId: string | null = null;
  try {
    runId = await recordRunStart({
      clienteSlug,
      agenteId: "facturacion",
      triggeredBy: req.headers.get("x-trigger") === "rerun" ? "rerun" : "cron",
    });
  } catch (err: any) {
    console.error("recordRunStart failed (no-fatal):", err.message);
    // No bloqueamos el pipeline si Supabase está caído.
  }

  let result: PipelineResult;
  try {
    result = await run(cfg);
  } catch (err: any) {
    console.error(JSON.stringify({
      level: "fatal",
      customerId: clienteSlug,
      error: err.message,
      stack: err.stack,
      hint: err.message?.includes("invalid_grant")
        ? "Refresh token expiró: corré scripts/setup-oauth.mjs local y actualizá GOOGLE_OAUTH_REFRESH_TOKEN en Netlify env vars"
        : undefined,
    }));

    if (runId) {
      try {
        await recordRunEnd({
          runId,
          status: "fail",
          durationMs: Date.now() - startedAt,
          error: err,
          netlifyLogUrl: process.env.URL
            ? `${process.env.URL}/.netlify/functions/facturacion-background`
            : undefined,
        });
      } catch (e: any) {
        console.error("recordRunEnd(fail) failed:", e.message);
      }
    }

    try {
      await notifyError(err, body.customerId);
    } catch {
      /* notify falla silencioso */
    }
    return new Response("internal error", { status: 500 });
  }

  const durationMs = Date.now() - startedAt;
  console.log(JSON.stringify({
    level: "result",
    customerId: clienteSlug,
    durationMs,
    procesadas: result.procesadas.length,
    errores: result.errores.length,
    saltadas: result.saltadas.length,
    sample: result.procesadas.slice(0, 3),
  }));

  // Registrar fin OK (o WARN si hubo errores parciales)
  if (runId) {
    try {
      const status: "ok" | "warn" = result.errores.length > 0 ? "warn" : "ok";
      const summary =
        `${result.procesadas.length} procesadas` +
        (result.errores.length ? ` · ${result.errores.length} errores` : "") +
        (result.saltadas.length ? ` · ${result.saltadas.length} saltadas` : "");
      await recordRunEnd({
        runId,
        status,
        durationMs,
        summary,
        payload: {
          procesadas: result.procesadas.length,
          errores: result.errores.length,
          saltadas: result.saltadas.length,
        },
      });
    } catch (e: any) {
      console.error("recordRunEnd(ok) failed:", e.message);
    }
  }

  // Email diario incondicional con resumen
  try {
    await notifyResult(result, body.customerId);
  } catch (err: any) {
    console.error("notify failed:", err.message);
  }

  return new Response(JSON.stringify({ ok: true, durationMs, runId }), {
    headers: { "content-type": "application/json" },
  });
};
```

- [ ] **Step 3: Verificar typecheck**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
npm run typecheck
```

Expected: sin errores.

- [ ] **Step 4: Verificar localmente con dry-run (no toca Supabase)**

```bash
npm run facturacion:dry-run
```

Expected: la CLI no llama a `recordRun*` (solo el background fn lo hace), corre como antes.

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add netlify/functions/facturacion-background.mts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(facturacion): instrumentar runs en agent_runs (Supabase)"
```

---

### Task 1.2: Endpoint Netlify `record-run.mts` (para Python)

**Files:**
- Create: `netlify/functions/record-run.mts`

- [ ] **Step 1: Crear el endpoint**

`netlify/functions/record-run.mts`:

```ts
// Endpoint HTTP que agentes en runtimes no-TS (ej Python) usan para
// reportar inicio/fin de un run a Supabase.
//
// Auth: header x-internal-secret == FACTURACION_INTERNAL_SECRET
// (reusamos el mismo secret que el cron-background).

import type { Config } from "@netlify/functions";
import {
  recordRunStart,
  recordRunEnd,
} from "../../shared/agents-runtime/src/record-run";

interface StartBody {
  action: "start";
  clienteSlug: string;
  agenteId: string;
  triggeredBy?: "cron" | "manual" | "rerun";
}

interface EndBody {
  action: "end";
  runId: string;
  status: "ok" | "fail" | "warn";
  durationMs: number;
  summary?: string;
  payload?: unknown;
  errorMessage?: string;
  errorStack?: string;
}

type Body = StartBody | EndBody;

export default async (req: Request) => {
  const secret = process.env.FACTURACION_INTERNAL_SECRET;
  const provided = req.headers.get("x-internal-secret");
  if (!secret || provided !== secret) {
    return new Response("unauthorized", { status: 401 });
  }

  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  try {
    if (body.action === "start") {
      const runId = await recordRunStart({
        clienteSlug: body.clienteSlug,
        agenteId: body.agenteId,
        triggeredBy: body.triggeredBy,
      });
      return new Response(JSON.stringify({ runId }), {
        headers: { "content-type": "application/json" },
      });
    }

    if (body.action === "end") {
      await recordRunEnd({
        runId: body.runId,
        status: body.status,
        durationMs: body.durationMs,
        summary: body.summary,
        payload: body.payload,
        error: body.errorMessage
          ? { message: body.errorMessage, stack: body.errorStack }
          : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("invalid action", { status: 400 });
  } catch (err: any) {
    console.error("record-run error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config: Config = {};
```

- [ ] **Step 2: Verificar typecheck**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
npm run typecheck
```

Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add netlify/functions/record-run.mts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): endpoint record-run para agentes non-TS"
```

---

### Task 1.3: Instrumentar `equipo-cartera/src/agent.py`

**Files:**
- Modify: `agentes/equipo-cartera/src/agent.py` (la función `main` del CLI)

- [ ] **Step 1: Agregar helper Python para POST a /record-run**

Crear `agentes/equipo-cartera/src/integraciones/runs_client.py`:

```python
"""Cliente HTTP que reporta inicio/fin de un run al endpoint Netlify /record-run."""
import os
import time
from typing import Optional, Any
import requests


_BASE = os.environ.get("RECORD_RUN_URL", "")
_SECRET = os.environ.get("FACTURACION_INTERNAL_SECRET", "")


def record_run_start(cliente_slug: str, agente_id: str, triggered_by: str = "cron") -> Optional[str]:
    """Inicia un run. Devuelve run_id o None si está deshabilitado / falla."""
    if not _BASE or not _SECRET:
        return None
    try:
        resp = requests.post(
            f"{_BASE}/.netlify/functions/record-run",
            headers={"x-internal-secret": _SECRET, "content-type": "application/json"},
            json={
                "action": "start",
                "clienteSlug": cliente_slug,
                "agenteId": agente_id,
                "triggeredBy": triggered_by,
            },
            timeout=5,
        )
        resp.raise_for_status()
        return resp.json().get("runId")
    except Exception as e:
        print(f"[record_run_start] no-fatal: {e}")
        return None


def record_run_end(
    run_id: Optional[str],
    status: str,
    duration_ms: int,
    summary: str = "",
    payload: Any = None,
    error_message: str = "",
    error_stack: str = "",
) -> None:
    """Cierra un run. Silencioso ante fallas (no bloquea el agente)."""
    if not _BASE or not _SECRET or not run_id:
        return
    try:
        requests.post(
            f"{_BASE}/.netlify/functions/record-run",
            headers={"x-internal-secret": _SECRET, "content-type": "application/json"},
            json={
                "action": "end",
                "runId": run_id,
                "status": status,
                "durationMs": duration_ms,
                "summary": summary,
                "payload": payload,
                "errorMessage": error_message,
                "errorStack": error_stack,
            },
            timeout=5,
        )
    except Exception as e:
        print(f"[record_run_end] no-fatal: {e}")
```

- [ ] **Step 2: Modificar `agent.py` para envolver el `main` con record-run**

En `agentes/equipo-cartera/src/agent.py`, en la función CLI (ej. `main()` o el bloque `if __name__ == "__main__"`), envolver la ejecución:

```python
import time
import traceback
from .integraciones.runs_client import record_run_start, record_run_end

def main():
    # ...parsing args, init...

    started = time.monotonic()
    run_id = record_run_start(
        cliente_slug=os.environ.get("CLIENTE_SLUG", "owner"),
        agente_id="cartera",
        triggered_by="cron" if os.environ.get("CRON") else "manual",
    )

    try:
        result = run_agent(...)  # la función existente del agente
        duration_ms = int((time.monotonic() - started) * 1000)
        summary = f"Decisión: {result.decision} | Iteraciones: {result.iteraciones}"
        record_run_end(
            run_id=run_id,
            status="ok",
            duration_ms=duration_ms,
            summary=summary,
            payload={"decision": result.decision, "iteraciones": result.iteraciones},
        )
        return result
    except Exception as e:
        duration_ms = int((time.monotonic() - started) * 1000)
        record_run_end(
            run_id=run_id,
            status="fail",
            duration_ms=duration_ms,
            error_message=str(e),
            error_stack=traceback.format_exc(),
        )
        raise
```

> El nombre exacto de `run_agent` depende de cómo está estructurado el CLI hoy. Si el `main()` actual no tiene una función única que retorne resultado, adaptar manteniendo la lógica try/finally.

- [ ] **Step 3: Verificar imports + tests Python**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/agentes/equipo-cartera
venv\Scripts\activate.bat
python -m pytest -v
```

Expected: los 24 tests existentes siguen pasando.

- [ ] **Step 4: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add agentes/equipo-cartera/src/integraciones/runs_client.py agentes/equipo-cartera/src/agent.py
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(cartera): reportar runs a /record-run"
```

---

### Task 1.4: Validación end-to-end de instrumentación

**Pre-requisito manual:** que la migración SQL (Task 0.1 step 2) esté corrida en Supabase.

- [ ] **Step 1: Configurar env vars de Netlify para el sitio principal**

Acción manual del Tomás (Netlify dashboard → site `equipodegentes` → Site configuration → Environment variables):

- `SUPABASE_URL` = (de pre-tarea P3)
- `SUPABASE_SERVICE_ROLE_KEY` = (de pre-tarea P3, marcado como sensitive)

- [ ] **Step 2: Trigger manual del cron de facturación**

```bash
curl -X POST https://<sitio-principal>.netlify.app/.netlify/functions/facturacion-background \
  -H "x-internal-secret: <FACTURACION_INTERNAL_SECRET>" \
  -H "content-type: application/json" \
  -d '{"dryRun": true}'
```

Expected: response 200 con `{ok: true, runId: "..."}`. En Netlify logs se ven `recordRunStart` y `recordRunEnd` sin errores.

- [ ] **Step 3: Verificar la fila en Supabase**

```sql
select id, agente_id, status, summary, started_at, finished_at, duration_ms
from equipodegentes.agent_runs
order by started_at desc
limit 1;
```

Expected: una fila con `status='ok'` o `status='warn'`, `summary` populado, `duration_ms` > 0.

> Si todo OK, la Fase 1 está validada. Si falla: revisar Netlify logs y confirmar env vars.

---

## Fase 2 — Panel MVP

### Task 2.1: Scaffold `apps/admin/` con Vite

**Files:**
- Create: `apps/admin/package.json`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/tsconfig.json`
- Create: `apps/admin/index.html`
- Create: `apps/admin/src/main.tsx`
- Create: `apps/admin/src/App.tsx`
- Create: `apps/admin/.env.example`
- Create: `apps/admin/.gitignore`

- [ ] **Step 1: Crear `apps/admin/package.json`**

```json
{
  "name": "@equipodegentes/admin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "@tanstack/react-query": "^5.50.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 2: Crear `apps/admin/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
```

- [ ] **Step 3: Crear `apps/admin/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "jsx": "react-jsx",
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Crear `apps/admin/index.html`**

```html
<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Panel · Equipo de Agentes</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Crear `apps/admin/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles/globals.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 6: Crear `apps/admin/src/App.tsx` (placeholder)**

```tsx
export default function App() {
  return (
    <div className="min-h-screen bg-paper text-ink p-6">
      <h1 className="font-serif text-3xl">Panel · Equipo de Agentes</h1>
      <p className="text-stone-600 mt-2">Scaffold OK · falta routing y data.</p>
    </div>
  );
}
```

- [ ] **Step 7: Crear `apps/admin/.env.example` y `apps/admin/.gitignore`**

`.env.example`:
```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_ADMIN_ALLOWED_EMAIL=tomasramirezvilla@gmail.com
```

`.gitignore`:
```
node_modules
dist
.env
.env.local
```

- [ ] **Step 8: Instalar deps**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/apps/admin
npm install
```

Expected: instala todo sin errores. `node_modules/` aparece.

- [ ] **Step 9: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): scaffold apps/admin con Vite+React+TS"
```

---

### Task 2.2: Tailwind con tokens del sistema interno

**Files:**
- Create: `apps/admin/tailwind.config.js`
- Create: `apps/admin/postcss.config.js`
- Create: `apps/admin/src/styles/globals.css`

- [ ] **Step 1: Crear `apps/admin/tailwind.config.js`**

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Sistema interno (Tools/pendientes) — papel + vermellón
        paper:    "#f7f2e8",
        paperalt: "#efe7d3",
        edge:     "#e0d6bd",
        ink:      "#2a2620",
        muted:    "#8a7f68",
        dim:      "#6b624f",
        accent:   "#c5443a",   // vermellón — primary action, errores
        ok:       "#5a8556",
        warn:     "#d4a017",
        fail:     "#c5443a",
        off:      "#cbc1a8",
      },
      fontFamily: {
        serif: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        sans:  ["ui-sans-serif", "system-ui", "sans-serif"],
        mono:  ["ui-monospace", "SF Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 2: Crear `apps/admin/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 3: Crear `apps/admin/src/styles/globals.css`**

```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&display=swap');

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  body {
    @apply bg-paper text-ink font-sans;
    -webkit-font-smoothing: antialiased;
  }
  h1, h2, h3, h4 {
    @apply font-serif;
  }
}

@layer components {
  .card {
    @apply bg-paper border border-edge rounded-md p-5;
  }
  .pill {
    @apply inline-block text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded;
  }
  .pill-ok   { @apply bg-green-100 text-green-800; }
  .pill-fail { @apply bg-red-100 text-red-800; }
  .pill-warn { @apply bg-amber-100 text-amber-800; }
  .pill-off  { @apply bg-stone-200 text-stone-600; }
  .label {
    @apply text-[10px] uppercase tracking-wider text-dim font-semibold;
  }
}
```

- [ ] **Step 4: Verificar dev server**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/apps/admin
npm run dev
```

Expected: server arranca en `http://localhost:5173`. Abrir en browser → ves el placeholder con fondo papel y título serif. Cerrar con Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/tailwind.config.js apps/admin/postcss.config.js apps/admin/src/styles/globals.css
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): tailwind config con tokens internos (papel + vermellón + Fraunces)"
```

---

### Task 2.3: Cliente Supabase + tipos DB

**Files:**
- Create: `apps/admin/src/lib/supabase.ts`
- Create: `apps/admin/src/types.ts`

- [ ] **Step 1: Crear `apps/admin/src/lib/supabase.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url) throw new Error("Falta VITE_SUPABASE_URL en .env");
if (!anonKey) throw new Error("Falta VITE_SUPABASE_ANON_KEY en .env");

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  db: { schema: "equipodegentes" },
});

export const ALLOWED_EMAIL =
  import.meta.env.VITE_ADMIN_ALLOWED_EMAIL ?? "tomasramirezvilla@gmail.com";
```

- [ ] **Step 2: Crear `apps/admin/src/types.ts`**

```ts
export type RunStatus = "running" | "ok" | "fail" | "warn";
export type TriggeredBy = "cron" | "manual" | "rerun";

export interface Cliente {
  id: string;
  nombre: string;
  slug: string;
  activo: boolean;
  notas: string | null;
  created_at: string;
}

export interface Agente {
  id: string;
  nombre: string;
  descripcion: string | null;
  cron_default: string | null;
  activo: boolean;
}

export interface ClientAgent {
  cliente_id: string;
  agente_id: string;
  activo: boolean;
  config: Record<string, unknown>;
  activated_at: string;
}

export interface AgentRun {
  id: string;
  cliente_id: string;
  agente_id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  triggered_by: TriggeredBy;
  summary: string | null;
  payload: unknown;
  error_message: string | null;
  error_stack: string | null;
  netlify_log_url: string | null;
}

export interface AgentEvent {
  id: string;
  run_id: string;
  cliente_id: string;
  agente_id: string;
  tipo: string;
  payload: Record<string, unknown>;
  created_at: string;
}
```

- [ ] **Step 3: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/lib/supabase.ts apps/admin/src/types.ts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): cliente supabase + types DB"
```

---

### Task 2.4: Login con magic link + protección de rutas

**Files:**
- Create: `apps/admin/src/lib/auth.ts`
- Create: `apps/admin/src/routes/login.tsx`
- Create: `apps/admin/src/components/LoginGate.tsx`

- [ ] **Step 1: `apps/admin/src/lib/auth.ts`**

```ts
import { useEffect, useState } from "react";
import { supabase, ALLOWED_EMAIL } from "./supabase";
import type { Session } from "@supabase/supabase-js";

export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

export function isAllowed(session: Session | null): boolean {
  return session?.user?.email === ALLOWED_EMAIL;
}

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
```

- [ ] **Step 2: `apps/admin/src/routes/login.tsx`**

```tsx
import { useState } from "react";
import { sendMagicLink } from "../lib/auth";
import { ALLOWED_EMAIL } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState(ALLOWED_EMAIL);
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    try {
      await sendMagicLink(email);
      setStatus("sent");
    } catch (err: any) {
      setErrMsg(err.message ?? String(err));
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper">
      <form onSubmit={handle} className="card max-w-md w-full">
        <h1 className="font-serif text-2xl mb-1">Panel · Equipo de Agentes</h1>
        <p className="text-sm text-muted mb-6">Acceso por magic link.</p>

        <label className="label block mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border border-edge rounded px-3 py-2 mb-4 bg-white"
          required
        />

        <button
          type="submit"
          disabled={status === "sending" || status === "sent"}
          className="bg-ink text-paper px-4 py-2 rounded text-sm font-semibold uppercase tracking-wider disabled:opacity-50"
        >
          {status === "sending" ? "Enviando..." : status === "sent" ? "Enviado ✓" : "Enviar link"}
        </button>

        {status === "sent" && (
          <p className="mt-4 text-sm text-ok">
            Revisa tu email. El link te trae de vuelta logueado.
          </p>
        )}
        {status === "error" && (
          <p className="mt-4 text-sm text-fail">Error: {errMsg}</p>
        )}
      </form>
    </div>
  );
}
```

- [ ] **Step 3: `apps/admin/src/components/LoginGate.tsx`**

```tsx
import { type ReactNode } from "react";
import { useSession, isAllowed } from "../lib/auth";
import Login from "../routes/login";

export default function LoginGate({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted">
        Cargando…
      </div>
    );
  }

  if (!session) return <Login />;

  if (!isAllowed(session)) {
    return (
      <div className="min-h-screen flex items-center justify-center text-fail">
        Email no autorizado.
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 4: Modificar `apps/admin/src/App.tsx` para usar el gate**

```tsx
import LoginGate from "./components/LoginGate";

export default function App() {
  return (
    <LoginGate>
      <div className="min-h-screen bg-paper text-ink p-6">
        <h1 className="font-serif text-3xl">Panel · Equipo de Agentes</h1>
        <p className="text-muted mt-2">Login OK · falta routing.</p>
      </div>
    </LoginGate>
  );
}
```

- [ ] **Step 5: Verificar manualmente**

Tomás:
1. Crear `apps/admin/.env` copiando `.env.example` y rellenando `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (de pre-tarea P3).
2. `npm run dev`
3. Browser: ver login form. Click "Enviar link". Revisar email. Click el link → vuelve a la app logueado.

Expected: ves el placeholder "Login OK · falta routing".

- [ ] **Step 6: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/lib/auth.ts apps/admin/src/routes/login.tsx apps/admin/src/components/LoginGate.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): magic link auth + login gate"
```

---

### Task 2.5: Layout + nav + queries

**Files:**
- Create: `apps/admin/src/components/Layout.tsx`
- Create: `apps/admin/src/components/Pill.tsx`
- Create: `apps/admin/src/lib/queries.ts`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/components/Pill.tsx`**

```tsx
import type { RunStatus } from "../types";

export default function Pill({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; label: string }> = {
    ok:      { cls: "pill-ok",   label: "OK" },
    fail:    { cls: "pill-fail", label: "FAIL" },
    warn:    { cls: "pill-warn", label: "WARN" },
    running: { cls: "pill-off",  label: "RUNNING" },
  };
  const { cls, label } = map[status];
  return <span className={`pill ${cls}`}>{label}</span>;
}
```

- [ ] **Step 2: `apps/admin/src/components/Layout.tsx`**

```tsx
import { type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { signOut } from "../lib/auth";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-edge bg-paperalt">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center gap-6">
          <Link to="/" className="font-serif text-lg font-semibold">
            Equipo de Agentes
          </Link>
          <nav className="flex gap-4 text-sm">
            <NavLink
              to="/"
              end
              className={({ isActive }) =>
                isActive ? "text-accent font-semibold" : "text-dim hover:text-ink"
              }
            >
              Matriz
            </NavLink>
            <NavLink
              to="/feed"
              className={({ isActive }) =>
                isActive ? "text-accent font-semibold" : "text-dim hover:text-ink"
              }
            >
              Feed
            </NavLink>
          </nav>
          <button
            onClick={() => signOut()}
            className="ml-auto text-xs text-muted hover:text-ink"
          >
            Salir
          </button>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 3: `apps/admin/src/lib/queries.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { Cliente, Agente, AgentRun } from "../types";

export function useClientes() {
  return useQuery({
    queryKey: ["clientes"],
    queryFn: async (): Promise<Cliente[]> => {
      const { data, error } = await supabase
        .from("clientes")
        .select("*")
        .eq("activo", true)
        .order("nombre");
      if (error) throw error;
      return data;
    },
  });
}

export function useAgentes() {
  return useQuery({
    queryKey: ["agentes"],
    queryFn: async (): Promise<Agente[]> => {
      const { data, error } = await supabase
        .from("agentes")
        .select("*")
        .eq("activo", true)
        .order("nombre");
      if (error) throw error;
      return data;
    },
  });
}

export function useLatestRuns() {
  return useQuery({
    queryKey: ["latest-runs"],
    queryFn: async (): Promise<AgentRun[]> => {
      // RPC más eficiente sería ideal; por ahora traemos los últimos 200 y agrupamos en cliente.
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data;
    },
  });
}

export function useRun(id: string) {
  return useQuery({
    queryKey: ["run", id],
    enabled: !!id,
    queryFn: async (): Promise<AgentRun> => {
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export function useRunsByClienteAgente(clienteId: string, agenteId: string, limit = 10) {
  return useQuery({
    queryKey: ["runs", clienteId, agenteId, limit],
    enabled: !!clienteId && !!agenteId,
    queryFn: async (): Promise<AgentRun[]> => {
      const { data, error } = await supabase
        .from("agent_runs")
        .select("*")
        .eq("cliente_id", clienteId)
        .eq("agente_id", agenteId)
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data;
    },
  });
}
```

- [ ] **Step 4: Modificar `App.tsx` para usar Layout y placeholder routes**

```tsx
import { Routes, Route } from "react-router-dom";
import LoginGate from "./components/LoginGate";
import Layout from "./components/Layout";

function Placeholder({ name }: { name: string }) {
  return <h2 className="font-serif text-2xl">{name}</h2>;
}

export default function App() {
  return (
    <LoginGate>
      <Layout>
        <Routes>
          <Route path="/" element={<Placeholder name="Matriz (próxima task)" />} />
          <Route path="/feed" element={<Placeholder name="Feed (próxima task)" />} />
          <Route path="/run/:id" element={<Placeholder name="Run detail" />} />
          <Route path="/cliente/:slug" element={<Placeholder name="Cliente" />} />
          <Route path="/agente/:id" element={<Placeholder name="Agente" />} />
          <Route path="*" element={<Placeholder name="404" />} />
        </Routes>
      </Layout>
    </LoginGate>
  );
}
```

- [ ] **Step 5: Verificar dev server**

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/apps/admin
npm run dev
```

Expected: header con nav (Matriz | Feed | Salir), navegación funciona.

- [ ] **Step 6: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/Layout.tsx apps/admin/src/components/Pill.tsx apps/admin/src/lib/queries.ts apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): layout + nav + react-query hooks"
```

---

### Task 2.6: Home — Matriz Clientes × Agentes

**Files:**
- Create: `apps/admin/src/routes/home.tsx`
- Create: `apps/admin/src/components/Matriz.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/components/Matriz.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useClientes, useAgentes, useLatestRuns } from "../lib/queries";
import type { AgentRun, RunStatus } from "../types";

function statusDot(status: RunStatus | "off"): string {
  return {
    ok:      "bg-ok",
    warn:    "bg-warn",
    fail:    "bg-fail",
    running: "bg-stone-300 animate-pulse",
    off:     "bg-off",
  }[status];
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function Matriz() {
  const { data: clientes, isLoading: lc } = useClientes();
  const { data: agentes, isLoading: la } = useAgentes();
  const { data: runs, isLoading: lr } = useLatestRuns();

  if (lc || la || lr) return <p className="text-muted">Cargando…</p>;
  if (!clientes || !agentes || !runs) return null;

  // Mapa { clienteId: { agenteId: ultimoRun } }
  const ultimo: Record<string, Record<string, AgentRun>> = {};
  for (const r of runs) {
    const byA = ultimo[r.cliente_id] ?? (ultimo[r.cliente_id] = {});
    if (!byA[r.agente_id]) byA[r.agente_id] = r;
  }

  const errCount = runs.filter((r) => r.status === "fail").length;
  const todayCount = runs.filter(
    (r) => new Date(r.started_at).toDateString() === new Date().toDateString()
  ).length;

  return (
    <div>
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-2 mb-6">
        <Kpi label="Runs hoy" val={String(todayCount)} />
        <Kpi label="Errores" val={String(errCount)} accent={errCount > 0} />
        <Kpi label="Clientes" val={String(clientes.length)} />
        <Kpi label="Agentes" val={String(agentes.length)} />
      </div>

      {/* Matriz */}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="text-left text-[10px] uppercase tracking-wider text-dim font-semibold py-2 px-3 bg-paperalt border border-edge">
              Cliente
            </th>
            {agentes.map((a) => (
              <th
                key={a.id}
                className="text-left text-[10px] uppercase tracking-wider text-dim font-semibold py-2 px-3 bg-paperalt border border-edge"
              >
                <Link to={`/agente/${a.id}`} className="hover:text-accent">
                  {a.nombre}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {clientes.map((c) => (
            <tr key={c.id}>
              <td className="bg-white border border-edge px-3 py-2 font-serif font-semibold">
                <Link to={`/cliente/${c.slug}`} className="hover:text-accent">
                  {c.nombre}
                </Link>
              </td>
              {agentes.map((a) => {
                const r = ultimo[c.id]?.[a.id];
                return (
                  <td key={a.id} className="border border-edge px-3 py-2">
                    {r ? (
                      <Link
                        to={`/run/${r.id}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <span
                          className={`w-2 h-2 rounded-full inline-block ${statusDot(r.status)}`}
                        />
                        <span className="text-xs">
                          {r.status.toUpperCase()} · {timeAgo(r.started_at)}
                        </span>
                      </Link>
                    ) : (
                      <span className="flex items-center gap-2 text-muted">
                        <span className={`w-2 h-2 rounded-full inline-block ${statusDot("off")}`} />
                        <span className="text-xs">no activado</span>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, val, accent = false }: { label: string; val: string; accent?: boolean }) {
  return (
    <div className="card py-3">
      <div className="label">{label}</div>
      <div className={`text-2xl font-semibold ${accent ? "text-accent" : ""}`}>{val}</div>
    </div>
  );
}
```

- [ ] **Step 2: `apps/admin/src/routes/home.tsx`**

```tsx
import Matriz from "../components/Matriz";

export default function Home() {
  return <Matriz />;
}
```

- [ ] **Step 3: Conectar la ruta en `App.tsx`**

Reemplazar `<Route path="/" element={<Placeholder name="Matriz..." />} />` por:

```tsx
import Home from "./routes/home";
// ...
<Route path="/" element={<Home />} />
```

- [ ] **Step 4: Verificar manualmente**

```bash
npm run dev
```

Expected: la matriz renderea. Si no hay clientes/agentes en la DB, salen tablas vacías. Si hay runs (de Task 1.4), se ven dots de estado.

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/Matriz.tsx apps/admin/src/routes/home.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): home matriz clientes × agentes"
```

---

### Task 2.7: Feed cronológico

**Files:**
- Create: `apps/admin/src/routes/feed.tsx`
- Create: `apps/admin/src/components/Feed.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/components/Feed.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useLatestRuns, useClientes, useAgentes } from "../lib/queries";
import Pill from "./Pill";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-CO", {
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "America/Bogota",
  });
}

export default function Feed() {
  const { data: runs, isLoading } = useLatestRuns();
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  if (isLoading) return <p className="text-muted">Cargando…</p>;
  if (!runs || !clientes || !agentes) return null;

  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      <h2 className="font-serif text-2xl mb-4">Feed cronológico</h2>
      <div className="card p-0 overflow-hidden">
        <div className="grid grid-cols-[110px_140px_1fr_1fr_80px] gap-3 px-4 py-2 bg-paperalt border-b border-edge label">
          <div>Hora</div>
          <div>Agente</div>
          <div>Cliente</div>
          <div>Resumen</div>
          <div>Estado</div>
        </div>
        {runs.map((r) => {
          const c = clienteById[r.cliente_id];
          const a = agenteById[r.agente_id];
          return (
            <Link
              key={r.id}
              to={`/run/${r.id}`}
              className="grid grid-cols-[110px_140px_1fr_1fr_80px] gap-3 px-4 py-2 border-b border-edge text-xs hover:bg-paperalt"
            >
              <div className="font-mono text-muted">{fmtTime(r.started_at)}</div>
              <div className="font-semibold">{a?.nombre ?? r.agente_id}</div>
              <div className="font-serif italic">{c?.nombre ?? r.cliente_id}</div>
              <div className="text-dim truncate">{r.summary ?? r.error_message ?? "—"}</div>
              <div><Pill status={r.status} /></div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `apps/admin/src/routes/feed.tsx`**

```tsx
import Feed from "../components/Feed";
export default function FeedRoute() {
  return <Feed />;
}
```

- [ ] **Step 3: Conectar la ruta en `App.tsx`**

```tsx
import FeedRoute from "./routes/feed";
// ...
<Route path="/feed" element={<FeedRoute />} />
```

- [ ] **Step 4: Verificar manualmente y commit**

```bash
npm run dev
# verificar /feed se ve OK

git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/Feed.tsx apps/admin/src/routes/feed.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): feed cronológico de runs"
```

---

### Task 2.8: Detalle de run + classify-error

**Files:**
- Create: `apps/admin/src/lib/classify-error.ts`
- Create: `apps/admin/src/components/RunDetail.tsx`
- Create: `apps/admin/src/routes/run.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/lib/classify-error.ts`**

```ts
export interface ErrorClassification {
  causaProbable: string;
  fixSugerido: string | null;
}

const RULES: Array<{ match: RegExp; classification: ErrorClassification }> = [
  {
    match: /invalid_grant/i,
    classification: {
      causaProbable:
        "El refresh token de Google fue revocado o expiró (Google los expira a 6 meses si la app está en modo Testing).",
      fixSugerido:
        "Regenerar el refresh token: correr `npm run facturacion:setup-oauth` local, copiar el nuevo refresh token a las env vars de Netlify (sin el `=` al inicio), y re-disparar.",
    },
  },
  {
    match: /rate.?limit|429/i,
    classification: {
      causaProbable: "Rate limit de la API externa.",
      fixSugerido: "Esperar 5-15 min y re-disparar. Si recurrente, reducir frecuencia o batch size.",
    },
  },
  {
    match: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
    classification: {
      causaProbable: "Problema de red llegando a la API externa.",
      fixSugerido: "Re-disparar. Si persiste, revisar status de la API afectada.",
    },
  },
];

export function classifyError(message: string | null): ErrorClassification | null {
  if (!message) return null;
  for (const r of RULES) {
    if (r.match.test(message)) return r.classification;
  }
  return {
    causaProbable: "No clasificado automáticamente.",
    fixSugerido: "Revisar el stack y los logs de Netlify para más contexto.",
  };
}
```

- [ ] **Step 2: `apps/admin/src/components/RunDetail.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useRun, useClientes, useAgentes, useRunsByClienteAgente } from "../lib/queries";
import { classifyError } from "../lib/classify-error";
import Pill from "./Pill";

export default function RunDetail({ runId }: { runId: string }) {
  const { data: run, isLoading } = useRun(runId);
  const { data: clientes } = useClientes();
  const { data: agentes } = useAgentes();

  if (isLoading || !run) return <p className="text-muted">Cargando run…</p>;

  const cliente = clientes?.find((c) => c.id === run.cliente_id);
  const agente  = agentes?.find((a) => a.id === run.agente_id);
  const errCls  = run.error_message ? classifyError(run.error_message) : null;

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link>
        {cliente && <> · <Link to={`/cliente/${cliente.slug}`} className="text-accent">{cliente.nombre}</Link></>}
        {agente  && <> · <Link to={`/agente/${agente.id}`} className="text-accent">{agente.nombre}</Link></>}
        {" · "}Run del {new Date(run.started_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}
      </div>

      <h1 className="font-serif text-2xl mb-1">
        Run · {agente?.nombre ?? run.agente_id}
      </h1>
      <div className="text-xs text-dim mb-6">
        <Pill status={run.status} />
        <span className="ml-3">
          Cliente: <strong>{cliente?.nombre ?? run.cliente_id}</strong>
          {" · "}duración {(run.duration_ms ?? 0) / 1000}s
          {" · "}trigger: {run.triggered_by}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <section className="card">
          <div className="label mb-2">Resumen</div>
          {run.summary ? <p className="text-sm">{run.summary}</p> : <p className="text-muted text-sm">—</p>}

          {run.error_message && (
            <>
              <div className="label mt-5 mb-2 text-fail">Error</div>
              <pre className="bg-ink text-paper text-[11px] font-mono p-3 rounded overflow-auto whitespace-pre-wrap">
{`${run.error_message}

${run.error_stack ?? ""}`}
              </pre>
              {errCls && (
                <div className="mt-3 text-xs">
                  <p><strong className="text-accent">Causa probable:</strong> {errCls.causaProbable}</p>
                  {errCls.fixSugerido && (
                    <p className="mt-1"><strong className="text-accent">Fix sugerido:</strong> {errCls.fixSugerido}</p>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <div className="label mb-2">Historial reciente</div>
          <Historial clienteId={run.cliente_id} agenteId={run.agente_id} excludeId={run.id} />

          {run.netlify_log_url && (
            <a
              href={run.netlify_log_url}
              target="_blank"
              rel="noreferrer"
              className="block mt-5 text-xs text-accent hover:underline"
            >
              Ver logs Netlify →
            </a>
          )}
        </section>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <button className="bg-accent text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold">
          Re-disparar run
        </button>
        <button className="bg-ink text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold">
          Pausar agente p/ este cliente
        </button>
        <button className="border border-ink text-ink px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold">
          Ver logs Netlify
        </button>
      </div>
      <p className="text-[10px] text-muted mt-2">
        (Acciones cableadas en Fase 3 — botones presentes pero no activos.)
      </p>
    </div>
  );
}

function Historial({
  clienteId,
  agenteId,
  excludeId,
}: { clienteId: string; agenteId: string; excludeId: string }) {
  const { data: runs } = useRunsByClienteAgente(clienteId, agenteId, 6);
  if (!runs) return <p className="text-muted text-sm">Cargando…</p>;
  const filtered = runs.filter((r) => r.id !== excludeId).slice(0, 5);
  if (filtered.length === 0) return <p className="text-muted text-sm">Sin historial previo.</p>;

  return (
    <ul className="text-xs space-y-1">
      {filtered.map((r) => (
        <li key={r.id} className="flex items-center gap-2 border-b border-edge pb-1">
          <span className="text-muted font-mono w-16">
            {new Date(r.started_at).toLocaleDateString("es-CO", { month: "short", day: "2-digit" })}
          </span>
          <Pill status={r.status} />
          <Link to={`/run/${r.id}`} className="text-dim truncate flex-1 hover:text-ink">
            {r.summary ?? r.error_message ?? "—"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: `apps/admin/src/routes/run.tsx`**

```tsx
import { useParams } from "react-router-dom";
import RunDetail from "../components/RunDetail";

export default function RunRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p>ID de run inválido.</p>;
  return <RunDetail runId={id} />;
}
```

- [ ] **Step 4: Conectar en `App.tsx`**

```tsx
import RunRoute from "./routes/run";
// ...
<Route path="/run/:id" element={<RunRoute />} />
```

- [ ] **Step 5: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/lib/classify-error.ts apps/admin/src/components/RunDetail.tsx apps/admin/src/routes/run.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): detalle de run con classify-error"
```

---

### Task 2.9: Ficha de cliente

**Files:**
- Create: `apps/admin/src/components/ClienteFicha.tsx`
- Create: `apps/admin/src/routes/cliente.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/components/ClienteFicha.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAgentes } from "../lib/queries";
import Pill from "./Pill";
import type { Cliente, AgentRun, ClientAgent } from "../types";

function useClienteBySlug(slug: string) {
  return useQuery({
    queryKey: ["cliente", slug],
    enabled: !!slug,
    queryFn: async (): Promise<{ cliente: Cliente; activaciones: ClientAgent[]; runs: AgentRun[] }> => {
      const { data: cliente, error: e1 } = await supabase
        .from("clientes")
        .select("*")
        .eq("slug", slug)
        .single();
      if (e1 || !cliente) throw new Error(e1?.message ?? "cliente no encontrado");

      const [{ data: activaciones, error: e2 }, { data: runs, error: e3 }] = await Promise.all([
        supabase.from("client_agents").select("*").eq("cliente_id", cliente.id),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("cliente_id", cliente.id)
          .order("started_at", { ascending: false })
          .limit(30),
      ]);
      if (e2) throw e2;
      if (e3) throw e3;
      return { cliente, activaciones: activaciones ?? [], runs: runs ?? [] };
    },
  });
}

export default function ClienteFicha({ slug }: { slug: string }) {
  const { data, isLoading } = useClienteBySlug(slug);
  const { data: agentes } = useAgentes();

  if (isLoading || !data || !agentes) return <p className="text-muted">Cargando…</p>;
  const { cliente, activaciones, runs } = data;
  const agenteById = Object.fromEntries(agentes.map((a) => [a.id, a]));

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · {cliente.nombre}
      </div>
      <h1 className="font-serif text-3xl mb-1">{cliente.nombre}</h1>
      <p className="text-xs text-dim mb-6">
        slug <code>{cliente.slug}</code> · activo desde {new Date(cliente.created_at).toLocaleDateString("es-CO")}
      </p>

      <div className="grid grid-cols-2 gap-5">
        <section className="card">
          <div className="label mb-2">Agentes activados</div>
          {activaciones.length === 0 && <p className="text-muted text-sm">Ninguno.</p>}
          <ul className="space-y-2">
            {activaciones.map((act) => {
              const a = agenteById[act.agente_id];
              const last = runs.find((r) => r.agente_id === act.agente_id);
              return (
                <li key={act.agente_id} className="flex items-center gap-3 border-b border-edge pb-2">
                  <Link to={`/agente/${act.agente_id}`} className="font-semibold hover:text-accent flex-1">
                    {a?.nombre ?? act.agente_id}
                  </Link>
                  {last ? (
                    <>
                      <Pill status={last.status} />
                      <Link to={`/run/${last.id}`} className="text-xs text-muted hover:text-ink">
                        último run
                      </Link>
                    </>
                  ) : (
                    <span className="text-xs text-muted">sin runs</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card">
          <div className="label mb-2">Últimos runs (todos los agentes)</div>
          <ul className="text-xs space-y-1">
            {runs.slice(0, 15).map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-edge pb-1">
                <span className="text-muted font-mono w-16">
                  {new Date(r.started_at).toLocaleDateString("es-CO", { month: "short", day: "2-digit" })}
                </span>
                <Pill status={r.status} />
                <Link to={`/run/${r.id}`} className="text-dim truncate flex-1 hover:text-ink">
                  <span className="text-ink">{agenteById[r.agente_id]?.nombre ?? r.agente_id}</span>
                  {" — "}
                  {r.summary ?? r.error_message ?? "—"}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `apps/admin/src/routes/cliente.tsx`**

```tsx
import { useParams } from "react-router-dom";
import ClienteFicha from "../components/ClienteFicha";

export default function ClienteRoute() {
  const { slug } = useParams<{ slug: string }>();
  if (!slug) return <p>Slug inválido.</p>;
  return <ClienteFicha slug={slug} />;
}
```

- [ ] **Step 3: Conectar en `App.tsx`**

```tsx
import ClienteRoute from "./routes/cliente";
// ...
<Route path="/cliente/:slug" element={<ClienteRoute />} />
```

- [ ] **Step 4: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/ClienteFicha.tsx apps/admin/src/routes/cliente.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): ficha de cliente con activaciones + runs recientes"
```

---

### Task 2.10: Vista de agente

**Files:**
- Create: `apps/admin/src/components/AgenteFicha.tsx`
- Create: `apps/admin/src/routes/agente.tsx`
- Modify: `apps/admin/src/App.tsx`

- [ ] **Step 1: `apps/admin/src/components/AgenteFicha.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useClientes } from "../lib/queries";
import Pill from "./Pill";
import type { Agente, AgentRun } from "../types";

function useAgenteData(id: string) {
  return useQuery({
    queryKey: ["agente", id],
    enabled: !!id,
    queryFn: async (): Promise<{ agente: Agente; runs: AgentRun[] }> => {
      const [{ data: agente, error: e1 }, { data: runs, error: e2 }] = await Promise.all([
        supabase.from("agentes").select("*").eq("id", id).single(),
        supabase
          .from("agent_runs")
          .select("*")
          .eq("agente_id", id)
          .order("started_at", { ascending: false })
          .limit(50),
      ]);
      if (e1 || !agente) throw new Error(e1?.message ?? "agente no encontrado");
      if (e2) throw e2;
      return { agente, runs: runs ?? [] };
    },
  });
}

export default function AgenteFicha({ id }: { id: string }) {
  const { data, isLoading } = useAgenteData(id);
  const { data: clientes } = useClientes();

  if (isLoading || !data || !clientes) return <p className="text-muted">Cargando…</p>;
  const { agente, runs } = data;
  const clienteById = Object.fromEntries(clientes.map((c) => [c.id, c]));

  return (
    <div>
      <div className="text-xs text-muted mb-2">
        <Link to="/" className="text-accent">Panel</Link> · {agente.nombre}
      </div>
      <h1 className="font-serif text-3xl mb-1">{agente.nombre}</h1>
      <p className="text-xs text-dim mb-6">
        id <code>{agente.id}</code>
        {agente.cron_default && <> · cron {agente.cron_default}</>}
        {agente.descripcion && <> · {agente.descripcion}</>}
      </p>

      <h2 className="font-serif text-xl mb-3">Últimos runs (todos los clientes)</h2>
      <div className="card p-0 overflow-hidden">
        {runs.map((r) => (
          <Link
            key={r.id}
            to={`/run/${r.id}`}
            className="grid grid-cols-[110px_1fr_1fr_80px] gap-3 px-4 py-2 border-b border-edge text-xs hover:bg-paperalt"
          >
            <div className="font-mono text-muted">
              {new Date(r.started_at).toLocaleString("es-CO", {
                month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
                timeZone: "America/Bogota",
              })}
            </div>
            <div className="font-serif italic">
              {clienteById[r.cliente_id]?.nombre ?? r.cliente_id}
            </div>
            <div className="text-dim truncate">{r.summary ?? r.error_message ?? "—"}</div>
            <div><Pill status={r.status} /></div>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `apps/admin/src/routes/agente.tsx`**

```tsx
import { useParams } from "react-router-dom";
import AgenteFicha from "../components/AgenteFicha";

export default function AgenteRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <p>ID inválido.</p>;
  return <AgenteFicha id={id} />;
}
```

- [ ] **Step 3: Conectar en `App.tsx` y limpiar**

```tsx
import AgenteRoute from "./routes/agente";
// ...
<Route path="/agente/:id" element={<AgenteRoute />} />
```

- [ ] **Step 4: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/AgenteFicha.tsx apps/admin/src/routes/agente.tsx apps/admin/src/App.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): vista de agente con runs cross-cliente"
```

---

### Task 2.11: Deploy a Netlify (sitio dedicado)

**Pre-requisito:** Pre-tarea P4 completa (sitio Netlify creado).

**Files:**
- Create: `apps/admin/netlify.toml`

- [ ] **Step 1: Crear `apps/admin/netlify.toml`**

```toml
[build]
  command = "npm install && npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

- [ ] **Step 2: Configurar env vars en Netlify (manual del Tomás)**

Netlify dashboard → site `equipodegentes-admin` → Environment variables:
- `VITE_SUPABASE_URL` (de pre-tarea P3)
- `VITE_SUPABASE_ANON_KEY` (de pre-tarea P3)
- `VITE_ADMIN_ALLOWED_EMAIL` = `tomasramirezvilla@gmail.com`

- [ ] **Step 3: Trigger deploy**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/netlify.toml
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "chore(admin): netlify.toml"
git -C c:/Users/TOMAS/Desktop/equipodegentes push origin main  # ⚠️ pedir OK al Tomás antes
```

- [ ] **Step 4: Verificar deploy en producción**

Tomás abre `https://equipodegentes-admin.netlify.app` → ve login → magic link a su email → entra → ve la matriz con datos reales de Supabase.

> 🛑 **Si el build falla en Netlify**: revisar logs del deploy. Causa común: env var faltante o falla `npm install` por workspaces (puede ser que necesite `npm install` desde la raíz, ajustar `netlify.toml` `command = "cd ../.. && npm install && cd apps/admin && npm run build"`).

---

## Fase 3 — Acciones operativas

### Task 3.1: Edge function `admin-trigger-rerun`

**Files:**
- Create: `apps/admin/netlify/edge-functions/admin-trigger-rerun.ts`
- Modify: `apps/admin/netlify.toml`

> **Decisión:** la edge function vive en el sitio admin (no en el principal) porque recibe llamadas del browser del admin. Hace POST autenticado al sitio principal donde corre la background function.

- [ ] **Step 1: Crear el directorio y el archivo**

`apps/admin/netlify/edge-functions/admin-trigger-rerun.ts`:

```ts
import type { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. Validar JWT de Supabase
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return new Response("missing auth", { status: 401 });

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const allowedEmail = Netlify.env.get("ADMIN_ALLOWED_EMAIL") ?? "tomasramirezvilla@gmail.com";

  const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: Netlify.env.get("SUPABASE_ANON_KEY") ?? "",
    },
  });
  if (!userResp.ok) return new Response("invalid token", { status: 401 });
  const user = await userResp.json();
  if (user.email !== allowedEmail) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Parsear body
  const { runId } = (await request.json()) as { runId: string };
  if (!runId) return new Response("missing runId", { status: 400 });

  // 3. Buscar el run y su agente
  const serviceKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const runResp = await fetch(
    `${supabaseUrl}/rest/v1/agent_runs?id=eq.${runId}&select=cliente_id,agente_id`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "equipodegentes",
      },
    }
  );
  const runs = await runResp.json();
  const run = Array.isArray(runs) ? runs[0] : null;
  if (!run) return new Response("run not found", { status: 404 });

  // 4. Resolver slug del cliente
  const cliResp = await fetch(
    `${supabaseUrl}/rest/v1/clientes?id=eq.${run.cliente_id}&select=slug`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Accept-Profile": "equipodegentes",
      },
    }
  );
  const cli = (await cliResp.json())[0];
  const clienteSlug = cli?.slug ?? "owner";

  // 5. Mapear agente_id a endpoint del sitio principal
  const mainSiteUrl = Netlify.env.get("MAIN_SITE_URL");
  const internalSecret = Netlify.env.get("FACTURACION_INTERNAL_SECRET");
  if (!mainSiteUrl || !internalSecret) {
    return new Response("server misconfigured", { status: 500 });
  }

  const endpoint = run.agente_id === "facturacion"
    ? `${mainSiteUrl}/.netlify/functions/facturacion-background`
    : null;

  if (!endpoint) {
    return new Response(`agent ${run.agente_id} no soporta re-disparo aún`, { status: 501 });
  }

  // 6. Disparar (no esperar — background fn devuelve 202 inmediato)
  fetch(endpoint, {
    method: "POST",
    headers: {
      "x-internal-secret": internalSecret,
      "x-trigger": "rerun",
      "content-type": "application/json",
    },
    body: JSON.stringify({ customerId: clienteSlug === "owner" ? undefined : clienteSlug }),
  }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, dispatched: endpoint }), {
    headers: { "content-type": "application/json" },
  });
};
```

- [ ] **Step 2: Modificar `apps/admin/netlify.toml` para registrar la edge function**

Reemplazar el contenido por:

```toml
[build]
  command = "npm install && npm run build"
  publish = "dist"

[[edge_functions]]
  function = "admin-trigger-rerun"
  path = "/api/trigger-rerun"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

- [ ] **Step 3: Variables de entorno necesarias en sitio admin**

Tomás en Netlify dashboard del sitio admin → Environment variables:
- `SUPABASE_URL` (sin VITE_ prefix — para edge fn server-side)
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MAIN_SITE_URL` = URL del sitio principal (ej `https://equipodegentes.netlify.app`)
- `FACTURACION_INTERNAL_SECRET` (mismo del sitio principal)
- `ADMIN_ALLOWED_EMAIL` = `tomasramirezvilla@gmail.com`

- [ ] **Step 4: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/netlify.toml apps/admin/netlify/edge-functions/admin-trigger-rerun.ts
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): edge function admin-trigger-rerun"
```

---

### Task 3.2: Cablear botón "Re-disparar" en RunDetail

**Files:**
- Modify: `apps/admin/src/components/RunDetail.tsx`

- [ ] **Step 1: Agregar el handler en RunDetail**

Reemplazar el bloque de botones (`<button className="bg-accent ...">Re-disparar run</button>`) por un componente nuevo. Al inicio de `RunDetail.tsx`, importar:

```tsx
import { useState } from "react";
import { supabase } from "../lib/supabase";
```

Y dentro del componente:

```tsx
const [rerunStatus, setRerunStatus] = useState<"idle" | "dispatching" | "ok" | "fail">("idle");
const [rerunMsg, setRerunMsg] = useState("");

async function handleRerun() {
  setRerunStatus("dispatching");
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("no session");

    const resp = await fetch("/api/trigger-rerun", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ runId: run.id }),
    });
    if (!resp.ok) {
      throw new Error(await resp.text());
    }
    setRerunStatus("ok");
    setRerunMsg("Disparado. El nuevo run aparecerá en la matriz en ~30s.");
  } catch (err: any) {
    setRerunStatus("fail");
    setRerunMsg(err.message ?? String(err));
  }
}
```

Reemplazar el bloque de botones por:

```tsx
<div className="mt-6 flex flex-wrap gap-2 items-center">
  <button
    onClick={handleRerun}
    disabled={rerunStatus === "dispatching" || rerunStatus === "ok"}
    className="bg-accent text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold disabled:opacity-50"
  >
    {rerunStatus === "dispatching" ? "Disparando…" : rerunStatus === "ok" ? "Disparado ✓" : "Re-disparar run"}
  </button>
  <button className="bg-ink text-paper px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold opacity-50 cursor-not-allowed" disabled>
    Pausar agente p/ este cliente
  </button>
  {run.netlify_log_url && (
    <a
      href={run.netlify_log_url}
      target="_blank"
      rel="noreferrer"
      className="border border-ink text-ink px-4 py-2 rounded text-xs uppercase tracking-wider font-semibold"
    >
      Ver logs Netlify
    </a>
  )}
  {rerunMsg && (
    <span className={`text-xs ${rerunStatus === "fail" ? "text-fail" : "text-ok"}`}>
      {rerunMsg}
    </span>
  )}
</div>
```

- [ ] **Step 2: Verificar manualmente**

```bash
npm run dev
# /run/<id-de-un-run-fallado> → click "Re-disparar". En Netlify logs del sitio principal,
# se ve la background function corriendo de nuevo. Aparece nueva fila en agent_runs.
```

- [ ] **Step 3: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/RunDetail.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): cablear botón re-disparar a edge fn"
```

---

### Task 3.3: Pausar/reactivar agente para un cliente

**Files:**
- Modify: `apps/admin/src/components/ClienteFicha.tsx`

- [ ] **Step 1: Agregar mutación en ClienteFicha**

Al inicio:
```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
```

Dentro del componente, después de los hooks de data:
```tsx
const qc = useQueryClient();
const togglePausa = useMutation({
  mutationFn: async (vars: { agenteId: string; activo: boolean }) => {
    const { error } = await supabase
      .from("client_agents")
      .update({ activo: vars.activo })
      .eq("cliente_id", cliente.id)
      .eq("agente_id", vars.agenteId);
    if (error) throw error;
  },
  onSuccess: () => qc.invalidateQueries({ queryKey: ["cliente", slug] }),
});
```

En el `<li>` de cada activación, agregar al final:
```tsx
<button
  onClick={() => togglePausa.mutate({ agenteId: act.agente_id, activo: !act.activo })}
  className="text-xs text-muted hover:text-fail"
  disabled={togglePausa.isPending}
>
  {act.activo ? "Pausar" : "Reactivar"}
</button>
```

> Importante: el agente facturación lee de env vars del sitio principal. Pausar acá NO impide que el cron lo dispare — solo lo marca como pausado en el panel. Para realmente impedir el run, en Task 3.4 (post-MVP) leer `client_agents.activo` desde el background fn y skip si está pausado.

- [ ] **Step 2: Commit**

```bash
git -C c:/Users/TOMAS/Desktop/equipodegentes add apps/admin/src/components/ClienteFicha.tsx
git -C c:/Users/TOMAS/Desktop/equipodegentes commit -m "feat(admin): toggle pausa de agente por cliente"
```

---

## Fase 4 — Post-MVP (no detallar steps por ahora)

Cuando el MVP esté en producción y operativo, abrir las siguientes tareas:

- **4.1** Agentes leen `client_agents.activo` antes de correr y respetan pausas.
- **4.2** Realtime updates con `supabase.channel()` para que la matriz se actualice sin reload.
- **4.3** `agent_events` granulares (factura procesada, préstamo escalado).
- **4.4** Editor JSON de `client_agents.config` en `/cliente/:slug`.
- **4.5** Dashboard de métricas agregadas (recuperación cartera, $ procesado facturas).
- **4.6** Multi-tenant real: app `apps/customer/` separada con login por cliente.

---

## Anti-bobos consolidado — todo lo que tiene que hacer Tomás "a mano"

Recopilado de las pre-tareas y env-vars manuales repartidas en el plan, en orden:

### Antes de la Fase 0
1. **Supabase**: SQL Editor → `create schema if not exists equipodegentes;`
2. **Supabase**: Settings → API → Exposed schemas → agregar `equipodegentes`
3. **Supabase**: copiar a temp file: Project URL, anon key, service_role key
4. **Netlify**: crear sitio nuevo `equipodegentes-admin` (base dir `apps/admin`, build `npm install && npm run build`, publish `apps/admin/dist`)
5. **Supabase Auth**: confirmar Email habilitado, agregar redirect URLs `localhost:5173/auth/callback` y `<sitio-admin>/auth/callback`

### Después de la Task 0.1
6. **Supabase SQL Editor**: pegar y correr el contenido de `0001_init_equipodegentes.sql`

### Después de la Task 1.4 (instrumentación)
7. **Netlify (sitio principal)**: agregar env vars `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

### Después de la Task 2.4 (login)
8. **Local**: crear `apps/admin/.env` desde `.env.example`, rellenar URL + anon key

### Después de la Task 2.11 (deploy)
9. **Netlify (sitio admin)**: env vars `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ADMIN_ALLOWED_EMAIL`
10. **OK explícito al `git push`** (no se hace automático)

### Después de la Task 3.1 (re-run)
11. **Netlify (sitio admin)**: env vars adicionales `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `MAIN_SITE_URL`, `FACTURACION_INTERNAL_SECRET`, `ADMIN_ALLOWED_EMAIL`

---

## Total estimado

| Fase | Tareas | Sesiones aprox |
|---|---|---|
| Pre-tareas (manual) | 5 | 30 min total |
| Fase 0 | 5 tareas (SQL + shared package) | 1 sesión |
| Fase 1 | 4 tareas (instrumentar agentes) | 1 sesión |
| Fase 2 | 11 tareas (panel MVP) | 2 sesiones |
| Fase 3 | 3 tareas (acciones) | 1 sesión |
| Fase 4 | post-MVP | a demanda |

**Total MVP: ~5 sesiones de trabajo + las pre-tareas manuales.**
