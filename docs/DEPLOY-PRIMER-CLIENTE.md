# Deploy del Panel + Primer Cliente (TÚ) — Paso a Paso

> Manual literal para Tomás. Cada paso tiene **lo que pegas**, **lo que esperas ver**, y **qué hacer si algo falla**. Tiempo total estimado: **45-60 minutos**.

> ⚙️ **Arquitectura**: este panel vive en un **proyecto Supabase dedicado** (independiente del de `consultoria-app`), un **sitio Netlify dedicado** (independiente del que corre los crons), y la branch `feat/admin-panel` del repo `equipodegentes`.

**Pre-requisito**: la branch `feat/admin-panel` ya está pusheada con todo el código. Verifica:

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
git status
```

Esperas: `On branch feat/admin-panel`. Si no, `git checkout feat/admin-panel`.

---

## Bloque A — Supabase: PROYECTO NUEVO dedicado (~10 min)

### A1. Crear el proyecto Supabase

- Ir a https://supabase.com/dashboard
- Click **New project**
- **Name**: `equipodegentes-prod`
- **Database password**: generá uno fuerte y **guárdalo en tu password manager** (lo vas a necesitar si algún día conectás directo a Postgres)
- **Region**: la más cercana a Bogotá — sugerencia: `South America (São Paulo)` o `East US (North Virginia)`
- **Plan**: Free
- Click **Create new project** y espera ~2 minutos a que provisionar termine

> ✅ Free tier permite hasta 2 proyectos por organización. Si ya tenés 2, vas a tener que pausar/borrar uno o pasar a Pro ($25/mes). Lo más probable es que solo tengas el de `consultoria-app`, así que entra.

### A2. Copiar las credenciales (3 valores) a un archivo temporal

- Cuando el proyecto esté listo, sidebar → **Project Settings (engranaje abajo) → API**
- Copia a un Notepad/`.txt` temporal en tu escritorio:

```
SUPABASE_URL=https://________.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...   ⚠️ SECRETA — nunca la pegues en el frontend
```

> 💡 La service_role aparece bajo "Project API keys → service_role". Si no la ves, click "Reveal".

### A3. Correr la migración SQL

- Sidebar → **SQL Editor → + New query**
- Abrí el archivo [docs/superpowers/migrations/0001_init_equipodegentes.sql](superpowers/migrations/0001_init_equipodegentes.sql) en VS Code
- Copia **TODO** el contenido
- Pégalo en el SQL Editor de Supabase
- Click **Run**

**Esperas ver:** `Success. No rows returned` (~3 segundos).

**Verificá** con una nueva query:

```sql
select count(*) as clientes from public.clientes;
select count(*) as agentes from public.agentes;
select count(*) as activaciones from public.client_agents;
```

**Esperas:**
- `clientes`: 1 (Owner Tomás)
- `agentes`: 2 (facturacion + cartera)
- `activaciones`: 1

**Si falla:**
- "permission denied" → estás en el proyecto equivocado, asegurate de estar en el nuevo `equipodegentes-prod`
- "syntax error" → no pegaste todo el archivo

### A4. Configurar Auth Redirect URLs

- Sidebar → **Authentication → URL Configuration**
- **Site URL**: `https://equipodegentes-admin.netlify.app`
  (si vas a usar otro nombre, anótalo y vuelve a este paso después de B1)
- **Redirect URLs** (cada una en una línea):
  ```
  http://localhost:5173/auth/callback
  https://equipodegentes-admin.netlify.app/auth/callback
  ```
- **Save**

---

## Bloque B — Netlify: nuevo sitio para el panel admin (~10 min)

### B1. Crear el sitio nuevo

- https://app.netlify.com → **Add new site → Import an existing project → Deploy with GitHub**
- Buscar y seleccionar el repo `Tomasrv1992/equipodegentes`

### B2. Configurar el build

En la pantalla de configuración del proyecto:

- **Branch to deploy:** `feat/admin-panel`
  (cuando hagas merge a main, lo cambias a `main`)
- **Base directory:** `apps/admin`
- **Build command:** `npm install && npm run build`
- **Publish directory:** `apps/admin/dist`
- **Site name** (en el step de naming): `equipodegentes-admin`

> ⚠️ NO clickees Deploy site todavía. Primero las env vars (B3). Si por error ya hiciste deploy, no pasa nada — el primer build va a fallar por falta de env vars; lo redisparás en B4.

### B3. Configurar env vars del sitio admin

Sidebar del sitio admin → **Site configuration → Environment variables → Add a single variable**.

Usá los valores de tu `.txt` del paso A2:

| Key | Value | Sensitive? |
|---|---|---|
| `VITE_SUPABASE_URL` | tu Supabase URL del proyecto NUEVO | No |
| `VITE_SUPABASE_ANON_KEY` | anon key del proyecto NUEVO | No |
| `VITE_ADMIN_ALLOWED_EMAIL` | `tomasramirezvilla@gmail.com` | No |
| `SUPABASE_URL` | mismo URL (sin `VITE_`) | No |
| `SUPABASE_ANON_KEY` | mismo anon key | No |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role del proyecto NUEVO | **Sí ⚠️** |
| `MAIN_SITE_URL` | URL de tu sitio principal Netlify (ej `https://equipodegentes.netlify.app`, sin slash final) | No |
| `FACTURACION_INTERNAL_SECRET` | mismo valor que ya está en el sitio principal | **Sí ⚠️** |
| `ADMIN_ALLOWED_EMAIL` | `tomasramirezvilla@gmail.com` | No |

> 💡 Para sacar `FACTURACION_INTERNAL_SECRET`: vé al sitio principal Netlify → Site configuration → Environment variables → busca la var, click ícono de ojo → copy.

> 💡 Para `MAIN_SITE_URL`: en Netlify, en el sitio principal, está arriba en grande. Sin slash al final.

### B4. Trigger el primer deploy

- Sidebar admin → **Deploys → Trigger deploy → Deploy site**
- Esperá ~2-3 min al build

**Esperas:** "Published" en verde + dominio activo `https://equipodegentes-admin.netlify.app`.

**Si falla:**
- "VITE_SUPABASE_URL is undefined" → falta una env var (revisá B3, copiaste mal el nombre)
- "Module not found" → reintenta el deploy una vez más
- "build exceeded memory" → no debería pasar con el build de Vite, mándame el log si pasa

---

## Bloque C — Netlify: env vars del sitio PRINCIPAL (~3 min)

Esto es para que `facturacion-background.mts` (el cron diario que ya tenés corriendo) pueda escribir runs al **proyecto Supabase nuevo** cuando corra.

### C1. Ir al sitio principal

- En Netlify dashboard, click en el sitio principal (NO el admin que acabás de crear) — el que ya tiene `facturacion-background` corriendo

### C2. Agregar 2 env vars

**Site configuration → Environment variables → Add a variable**

| Key | Value | Sensitive |
|---|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase NUEVO (de A2) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role del proyecto NUEVO (de A2) | **Sí ⚠️** |

> ⚠️ **Importante**: estas son las credenciales del proyecto NUEVO `equipodegentes-prod`. NO las del proyecto `consultoria-app`. El sitio principal antes no tenía ninguna conexión a Supabase del de consultoria; ahora va a hablar con el nuevo.

### C3. Re-deploy del sitio principal

Sidebar → **Deploys → Trigger deploy → Deploy site**.

Las env vars solo se cargan al re-build/re-deploy. Sin esto, los próximos crons no van a poder escribir a Supabase.

---

## Bloque D — Verificación end-to-end (~10 min)

### D1. Loguearte al panel admin

- Abrí `https://equipodegentes-admin.netlify.app`
- Verás la pantalla de login con tu email pre-rellenado
- Click **Enviar link**
- Revisá tu Gmail (`tomasramirezvilla@gmail.com`). Llega un correo de Supabase con el magic link
- Click el link

**Esperas:** te trae al panel admin con la matriz cargada. **El cliente "Owner (Tomás)" aparece como fila** y la celda de facturación dice "no activado" (porque todavía no hay runs).

**Si falla:**
- "Email no autorizado" → la env var `VITE_ADMIN_ALLOWED_EMAIL` no es exacta. Revisá B3 y re-deployá.
- "Cargando…" infinito → F12 → Console. Si dice "permission denied" → falta correr la migración (A3) o tienes el proyecto Supabase mal.
- No llega el email → spam. Si nada, Supabase → Authentication → Logs.

### D2. Disparar manualmente la primera corrida del agente facturación

PowerShell en `c:/Users/TOMAS/Desktop/equipodegentes`:

```powershell
$secret = "PEGA_ACA_FACTURACION_INTERNAL_SECRET"
$mainUrl = "https://equipodegentes.netlify.app"  # tu sitio principal
Invoke-RestMethod -Uri "$mainUrl/.netlify/functions/facturacion-background" `
  -Method POST `
  -Headers @{ "x-internal-secret" = $secret; "content-type" = "application/json" } `
  -Body '{"dryRun": true}'
```

Reemplazá `PEGA_ACA_FACTURACION_INTERNAL_SECRET` por el valor real (el mismo de B3 / del sitio principal).

**Esperas:** JSON `{ ok: true, durationMs: <numero>, runId: "<uuid>" }`.

**Si falla:**
- 401 unauthorized → secret mal
- 500 internal error → mirá los logs en Netlify del sitio principal → Functions → `facturacion-background`

### D3. Verificar que el run aparece en el panel

- Vuelvé al panel admin
- Refrescá la página
- En la matriz, **Owner (Tomás) × Equipo-facturación** debería mostrar un dot 🟢 o 🟡 + timestamp
- Click en la celda → detalle del run con resumen, payload, etc.

**Esperas:** info completa del run.

**Si la fila no aparece:**
- Supabase → Table Editor → `agent_runs` — ¿hay fila? Si no, el cron no pudo escribir (revisá Netlify logs principal)
- Si la fila existe pero el panel no la muestra: F12 → Console del browser, mirá errores

### D4. Probar feed + drill-down

- Click **Feed** en el header → ves el run listado
- Click en **Owner (Tomás)** en la matriz → ficha del cliente con activaciones + runs
- Click en **Equipo-facturación** (header de columna) → ficha del agente

---

## Bloque E — Tu primer cliente bien configurado (~5 min)

Opcional pero recomendado para que la metadata se vea bonita en el panel.

### E1. Actualizar nombre y notas del cliente

Supabase SQL Editor:

```sql
update public.clientes
set nombre = 'Tomás (Owner)',
    notas = 'Single-tenant inicial. Credenciales del agente facturación en env vars del sitio principal Netlify.'
where slug = 'owner';
```

### E2. (Opcional) Config del client_agent con tus datos reales

```sql
update public.client_agents
set config = jsonb_build_object(
  'sheet_id', '1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU',
  'drive_folder', 'facturas-tomas-2026',
  'notify_email', 'tomasramirezvilla@gmail.com',
  'cron', '0 12 * * *'
)
where cliente_id = (select id from public.clientes where slug = 'owner')
  and agente_id = 'facturacion';
```

Solo afecta lo que se muestra en `/cliente/owner` del panel. El agente sigue leyendo env vars del sitio principal.

---

## Bloque F — Producción (cuando todo esté validado, ~2 min)

### F1. PR + merge

- https://github.com/Tomasrv1992/equipodegentes/pull/new/feat/admin-panel
- Título: `feat: panel de control de agentes (MVP)`
- **Create pull request** → **Merge pull request** → eliminar branch (opcional)

### F2. Sitio admin apuntando a main

- Sitio admin Netlify → Site configuration → Build & deploy → Branch deploys
- **Production branch**: cambiar de `feat/admin-panel` → `main`
- Trigger deploy

---

## ❓ Si algo no funciona

Mándame:
1. Qué paso falló
2. El error literal (copy/paste)
3. Screenshot si es UI

---

## ✅ Checklist resumen

**Bloque A — Supabase proyecto nuevo** (~10 min)
- [ ] A1 — Proyecto `equipodegentes-prod` creado
- [ ] A2 — 3 credenciales copiadas
- [ ] A3 — Migración SQL corrida y verificada
- [ ] A4 — Auth Redirect URLs configurados

**Bloque B — Netlify admin** (~10 min)
- [ ] B1 — Sitio nuevo creado desde GitHub
- [ ] B2 — Build configurado
- [ ] B3 — 9 env vars agregadas
- [ ] B4 — Primer deploy verde

**Bloque C — Netlify principal** (~3 min)
- [ ] C1 — En el sitio principal
- [ ] C2 — 2 env vars agregadas (apuntando al proyecto NUEVO)
- [ ] C3 — Re-deploy disparado

**Bloque D — Verificación** (~10 min)
- [ ] D1 — Login al panel funciona
- [ ] D2 — Run manual exitoso
- [ ] D3 — Run aparece en la matriz
- [ ] D4 — Feed + drill-down OK

**Bloque E — Tu cliente** (~5 min)
- [ ] E1 — Nombre y notas actualizados
- [ ] E2 — (Opcional) Config con datos reales

**Bloque F — Producción** (~2 min)
- [ ] F1 — PR creado y mergeado
- [ ] F2 — Sitio admin en main

---

**Cuando termines D3** (run aparece en matriz), la app está oficialmente viva. E y F son polish.
