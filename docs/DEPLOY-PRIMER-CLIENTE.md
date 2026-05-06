# Deploy del Panel + Primer Cliente (TÚ) — Paso a Paso

> Manual literal para Tomás. Cada paso tiene **lo que pegas**, **lo que esperas ver**, y **qué hacer si algo falla**. Tiempo total estimado: **45-60 minutos**.

**Pre-requisito:** la branch `feat/admin-panel` ya está pusheada con todo el código (22 commits). Antes de empezar este manual, verifica que estás en esa branch:

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
git status
```

Esperas ver: `On branch feat/admin-panel`. Si no, corre `git checkout feat/admin-panel`.

---

## Bloque A — Supabase setup (~10 min)

### A1. Abrir el proyecto Supabase

- Ir a https://supabase.com/dashboard
- Click en el proyecto que ya usas para `consultoria-app`

> ⚠️ Importante: NO crees un proyecto nuevo. Vamos a reutilizar este, con un **schema dedicado** para que los datos no se mezclen.

### A2. Crear el schema `equipodegentes`

- Click en **SQL Editor** (ícono de base de datos en la barra izquierda)
- Click en **+ New query**
- Pega EXACTAMENTE esto:

```sql
create schema if not exists equipodegentes;
```

- Click **Run** (o Ctrl+Enter)

**Esperas ver:** `Success. No rows returned`

### A3. Exponer el schema en la API

- Sidebar izquierda → **Project Settings** (ícono de engranaje abajo)
- Click **API**
- Buscar la sección **Exposed schemas** (suele estar abajo, debajo de "Data API Settings")
- Verás algo como `public, graphql_public`
- Edita y agrega `equipodegentes` separado por coma. Debe quedar:
  ```
  public, graphql_public, equipodegentes
  ```
- Click **Save**

**Esperas ver:** un toast verde de confirmación.

**Si falla:** asegúrate de no haber dejado espacios raros. La lista es CSV simple.

### A4. Copiar las credenciales (3 valores) a un archivo temporal

Sigues en **Project Settings → API**. Necesitas copiar 3 cosas a un Notepad o `.txt` temporal en tu escritorio (las usaremos en varios pasos):

- **Project URL** — algo como `https://abcd1234.supabase.co`
- **Project API keys → anon `public`** — empieza con `eyJ...` (es la pública, va al frontend)
- **Project API keys → service_role** — empieza con `eyJ...` (es SECRETA, NUNCA va al frontend, marcala con ⚠️ en el txt)

Guárdalas con etiquetas claras:

```
SUPABASE_URL=https://abcd1234.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ... (⚠️ SECRETA)
```

### A5. Correr la migración SQL

- Vuelve a **SQL Editor** → **+ New query**
- Abre el archivo `docs/superpowers/migrations/0001_init_equipodegentes.sql` desde tu repo (en VS Code o Notepad)
- Copia TODO el contenido del archivo
- Pégalo en el SQL Editor de Supabase
- Click **Run**

**Esperas ver:** `Success. No rows returned`. Tarda ~3 segundos.

**Para verificar que todo se creó bien**, en una nueva query corre:

```sql
select count(*) as clientes from equipodegentes.clientes;
select count(*) as agentes from equipodegentes.agentes;
select count(*) as activaciones from equipodegentes.client_agents;
```

**Esperas ver:**
- `clientes`: 1 (tú, "Owner (Tomás)")
- `agentes`: 2 (facturacion + cartera)
- `activaciones`: 1 (facturación activado para owner)

**Si falla:**
- Si dice "schema equipodegentes does not exist" → repetiste A2 mal, vuelve a hacerlo.
- Si dice "permission denied for schema" → falta el paso A3.

### A6. Configurar Auth Redirect URLs

- Sidebar → **Authentication** → **URL Configuration**
- En **Site URL** pon: `https://equipodegentes-admin.netlify.app`
  (Si pensás usar otro nombre de sitio, pon ese — pero **anótalo** porque tiene que coincidir con el de Netlify en B2.)
- En **Redirect URLs** agrega estas 2 (cada una en una línea):
  ```
  http://localhost:5173/auth/callback
  https://equipodegentes-admin.netlify.app/auth/callback
  ```
- Click **Save**

---

## Bloque B — Netlify: nuevo sitio para el panel admin (~10 min)

### B1. Crear el sitio nuevo

- Ir a https://app.netlify.com
- Click **Add new site** → **Import an existing project**
- Click **Deploy with GitHub**
- Si te pide autorizar Netlify a ver más repos, autorizalo
- Buscar y seleccionar el repo `Tomasrv1992/equipodegentes`

### B2. Configurar el build

En la pantalla de configuración:

- **Branch to deploy:** `feat/admin-panel`
  (más adelante, cuando hagas el merge a main, cambiás esto a `main`)
- **Base directory:** `apps/admin`
- **Build command:** `npm install && npm run build`
- **Publish directory:** `apps/admin/dist`
- **Site name:** abajo en el step de "Site name", pon `equipodegentes-admin`
  (si está ocupado, prueba `equipodegentes-admin-tomas`. Si lo cambias, vuelve a A6 y arregla el dominio.)

**NO clickees Deploy site todavía.** Primero las env vars (B3-B4). Si por error ya hiciste deploy, no pasa nada — el primer build va a fallar por falta de env vars; lo redisparas después.

### B3. Configurar env vars del sitio admin

Sidebar del sitio → **Site configuration** → **Environment variables**

Agrega cada una con click en **Add a variable** → **Add a single variable**:

| Key | Value | Scopes (default) |
|---|---|---|
| `VITE_SUPABASE_URL` | (Supabase URL del A4) | All scopes |
| `VITE_SUPABASE_ANON_KEY` | (anon key del A4) | All scopes |
| `VITE_ADMIN_ALLOWED_EMAIL` | `tomasramirezvilla@gmail.com` | All scopes |
| `SUPABASE_URL` | (mismo de arriba, sin VITE_) | All scopes |
| `SUPABASE_ANON_KEY` | (mismo anon key) | All scopes |
| `SUPABASE_SERVICE_ROLE_KEY` | (service_role del A4 ⚠️) | **Marca como "Sensitive"** |
| `MAIN_SITE_URL` | (URL de tu sitio principal Netlify, ej `https://equipodegentes.netlify.app`) | All scopes |
| `FACTURACION_INTERNAL_SECRET` | (mismo valor que ya tienes en el sitio principal) | **Sensitive** |
| `ADMIN_ALLOWED_EMAIL` | `tomasramirezvilla@gmail.com` | All scopes |

> 💡 Para sacar `FACTURACION_INTERNAL_SECRET`: ve al sitio principal Netlify → Site configuration → Environment variables → buscalo ahí, click ojo para ver el valor, copia.

> 💡 Para sacar `MAIN_SITE_URL`: en Netlify, en el sitio principal, está arriba en grande. Ej: `https://equipodegentes.netlify.app`. Sin slash al final.

### B4. Trigger el primer deploy

- Sidebar del sitio admin → **Deploys** → **Trigger deploy** → **Deploy site**
- Espera ~2-3 min al build

**Esperas ver:** "Published" en verde y un dominio activo `https://equipodegentes-admin.netlify.app`.

**Si falla:** click en el deploy fallido y revisa los logs. Causas comunes:
- "VITE_SUPABASE_URL is undefined" → falta una env var (revisa B3)
- "Module not found" → algo raro con npm; vuelve a triggear deploy

---

## Bloque C — Netlify: env vars del sitio PRINCIPAL (~3 min)

Esto es para que `facturacion-background.mts` pueda escribir runs a Supabase cuando corra el cron.

### C1. Ir al sitio principal

- En Netlify dashboard, click en el sitio principal (NO el admin que acabas de crear) — el que ya tiene `facturacion-background` corriendo

### C2. Agregar 2 env vars

**Site configuration** → **Environment variables** → **Add a variable**

| Key | Value | Scopes |
|---|---|---|
| `SUPABASE_URL` | (mismo de A4) | All scopes |
| `SUPABASE_SERVICE_ROLE_KEY` | (service_role de A4 ⚠️) | **Sensitive** |

### C3. Re-deploy del sitio principal

Sidebar → **Deploys** → **Trigger deploy** → **Deploy site**.

Las env vars solo se cargan al re-build/re-deploy, así que sin esto los próximos crons no van a poder escribir a Supabase.

---

## Bloque D — Verificación end-to-end (~10 min)

### D1. Loguearte al panel admin

- Abrir `https://equipodegentes-admin.netlify.app`
- Verás la pantalla de login con tu email pre-rellenado
- Click **Enviar link**
- Revisa tu Gmail (`tomasramirezvilla@gmail.com`). Debería llegar un correo de Supabase con un link "Magic Link" o "Confirm your signup"
- Click el link

**Esperas ver:** te trae al panel admin, con la matriz cargada. Como aún no hay runs, las celdas dicen "no activado" o están vacías. **El cliente "Owner (Tomás)" debería aparecer como fila.**

**Si falla:**
- "Email no autorizado" → la env var `VITE_ADMIN_ALLOWED_EMAIL` no es exactamente `tomasramirezvilla@gmail.com`. Re-revisa B3 y re-deploya.
- "Cargando…" infinito → abrir DevTools (F12) → Console. Si dice "schema equipodegentes does not exist" o similar → falta el A3 (Exposed schemas).
- No llega el email → mira en spam. Si no, revisa Supabase → Authentication → Logs.

### D2. Disparar manualmente la primera corrida del agente facturación

Esto es para confirmar que el agente escribe a Supabase y que el panel lo refleja.

Abre PowerShell en `c:/Users/TOMAS/Desktop/equipodegentes` y corre:

```powershell
$secret = "PEGA_ACA_FACTURACION_INTERNAL_SECRET"
$mainUrl = "https://equipodegentes.netlify.app"  # tu sitio principal
Invoke-RestMethod -Uri "$mainUrl/.netlify/functions/facturacion-background" `
  -Method POST `
  -Headers @{ "x-internal-secret" = $secret; "content-type" = "application/json" } `
  -Body '{"dryRun": true}'
```

Reemplaza `PEGA_ACA_FACTURACION_INTERNAL_SECRET` por el valor real (mismo que pusiste en B3).

**Esperas ver:** una respuesta JSON con `ok: true`, `durationMs: <número>`, `runId: "<uuid>"`.

**Si falla:**
- 401 unauthorized → el secret está mal. Verifica que el valor en PowerShell coincide exacto con la env var.
- 500 internal error → algo más profundo. Mira logs en Netlify del sitio principal → Functions → `facturacion-background`. Mándame el error.

### D3. Verificar que el run aparece en el panel

- Vuelve al panel admin (`/`)
- Refresca la página
- En la matriz, la celda **Owner (Tomás) × Equipo-facturación** debería tener un dot verde 🟢 (OK) o amarillo 🟡 (warn) o rojo 🔴 (fail) — y un timestamp tipo "ahora" o "1m"
- Click en la celda → te lleva al detalle del run con resumen, summary, etc.

**Esperas ver:** la información completa del run. Si fue dryRun, verás `triggered_by: cron` y un summary con cantidades.

**Si no aparece:**
- Revisar Supabase → Table Editor → `equipodegentes.agent_runs` — ¿hay una fila? Si no, el agente no pudo escribir (revisar Netlify logs del sitio principal).
- Si la fila existe pero el panel no la muestra: F12 → Console del browser, mira si hay errores de RLS.

### D4. Verificar el feed cronológico

- En el panel, click en **Feed** en el header
- Debería listarte el run que acabas de generar

### D5. Probar drill-down de cliente y agente

- Click en **Owner (Tomás)** en la matriz → ficha del cliente con sus activaciones y runs
- Click en **Equipo-facturación** (el header de la columna) → ficha del agente con runs cross-cliente

---

## Bloque E — Que tu primer cliente (TÚ) quede bien configurado (~5 min)

El seed creó al cliente "Owner (Tomás)" con slug `owner` y una activación de facturación con `config` placeholder. En tu caso single-tenant, el agente lee de **env vars del sitio principal** (no del config en Supabase), así que esto **no es estrictamente necesario** — pero lo dejamos correcto para cuando entre el segundo cliente.

### E1. Actualizar nombre y notas del cliente

En Supabase SQL Editor:

```sql
update equipodegentes.clientes
set nombre = 'Tomás (Owner)',
    notas = 'Single-tenant inicial. Credenciales en env vars del sitio principal Netlify.'
where slug = 'owner';
```

### E2. (Opcional) Actualizar el config del client_agent con tus datos reales

```sql
update equipodegentes.client_agents
set config = jsonb_build_object(
  'sheet_id', '1dwCu-1ooeyOC5PEd2lBIhua4zUmC5ymymQ6X0O4zcMU',  -- tu sheet real
  'drive_folder', 'facturas-tomas-2026',                        -- tu folder Drive
  'notify_email', 'tomasramirezvilla@gmail.com',
  'cron', '0 12 * * *'
)
where cliente_id = (select id from equipodegentes.clientes where slug = 'owner')
  and agente_id = 'facturacion';
```

Esto solo **muestra** info en el panel (en `/cliente/owner` verás los valores). El agente sigue usando env vars.

---

## Bloque F — Cuando todo esté validado, mergear a main (~2 min)

Cuando hayas verificado que el panel funciona end-to-end, podemos pasar la branch a main.

### F1. Pull request en GitHub

- Ve a https://github.com/Tomasrv1992/equipodegentes/pull/new/feat/admin-panel
- Título: `feat: panel de control de agentes (MVP)`
- Click **Create pull request**
- Click **Merge pull request**
- Confirmar merge → eliminar branch (si quieres)

### F2. Apuntar el sitio Netlify admin a main

- Sitio admin Netlify → Site configuration → Build & deploy → Branch deploys
- Cambiar **Production branch** de `feat/admin-panel` a `main`
- Trigger deploy

---

## ❓ Si algo no funciona

Mándame:
1. **Qué paso falló** (ej: "B4 deploy falló")
2. **El error literal** (copia/pega)
3. **Screenshot si es UI**

Y vemos. Cada paso es independiente — si A1-A6 funcionaron pero B falla, no hay que repetir A.

---

## ✅ Checklist resumen (marca cuando termines)

**Bloque A — Supabase** (~10 min)
- [ ] A1 — Proyecto Supabase abierto
- [ ] A2 — Schema `equipodegentes` creado
- [ ] A3 — Schema expuesto en API
- [ ] A4 — Credenciales copiadas a archivo temporal
- [ ] A5 — Migración SQL corrida y verificada
- [ ] A6 — Auth Redirect URLs configurados

**Bloque B — Netlify admin** (~10 min)
- [ ] B1 — Sitio nuevo creado desde GitHub
- [ ] B2 — Build configurado (base/command/publish)
- [ ] B3 — 9 env vars agregadas
- [ ] B4 — Primer deploy verde

**Bloque C — Netlify principal** (~3 min)
- [ ] C1 — En el sitio principal
- [ ] C2 — 2 env vars agregadas
- [ ] C3 — Re-deploy disparado

**Bloque D — Verificación** (~10 min)
- [ ] D1 — Login al panel funciona
- [ ] D2 — Run manual exitoso (curl/Invoke-RestMethod)
- [ ] D3 — Run aparece en la matriz
- [ ] D4 — Feed funcional
- [ ] D5 — Drill-down de cliente y agente OK

**Bloque E — Tu cliente** (~5 min)
- [ ] E1 — Nombre y notas actualizados
- [ ] E2 — (Opcional) Config con datos reales

**Bloque F — Producción** (~2 min)
- [ ] F1 — PR creado y mergeado
- [ ] F2 — Sitio admin apuntando a main

---

**Cuando termines D3 (run aparece en matriz)**, la app está oficialmente viva. E y F son polish + producción.
