# Agregar cliente nuevo — Manual (proceso manual)

> Manual literal para Tomás cuando vendas el agente a un cliente nuevo. Funciona hoy, sin necesidad del OAuth flow automatizado (eso queda para Fase 3 del spec multi-tenant).
>
> ⏱ **Tiempo total**: 30-45 min por cliente nuevo. Muy laborioso al principio — por eso la Fase 3 del spec automatiza esto.

---

## Resumen del proceso

1. Tomás se sienta junto al cliente (presencial o videocall)
2. Crean OAuth Client Google con la cuenta del cliente
3. Tomás corre el script de setup-oauth con esas credenciales
4. Tomás carga las credenciales en Netlify (sitio cron)
5. Tomás agrega el cliente al panel admin
6. Tomás verifica con un dry-run

> ⚠️ **Importante**: este proceso requiere acceso a la cuenta Google del cliente. El cliente tiene que estar ahí (videocall) o darte sus credenciales temporalmente. Por eso la Fase 3 del spec lo automatiza.

---

## Bloque A — Setup OAuth con el cliente (~10 min)

### A1. Cliente accede a su Google Cloud Console

Con el cliente al lado:

1. El cliente abre https://console.cloud.google.com con SU cuenta de Google
2. Crear nuevo proyecto:
   - Click el dropdown arriba a la izquierda (donde dice el nombre del proyecto actual)
   - **New Project**
   - Project name: `equipodegentes-facturacion`
   - **Create**
3. Esperar a que se cree el proyecto (~30 seg) y seleccionarlo

### A2. Habilitar APIs

Con el proyecto seleccionado:

1. Sidebar izquierda → **APIs & Services → Library**
2. Buscar y habilitar 3 APIs (una por una):
   - **Gmail API** → Enable
   - **Google Drive API** → Enable
   - **Google Sheets API** → Enable

### A3. Configurar OAuth consent screen

1. Sidebar → **APIs & Services → OAuth consent screen**
2. **External** → Create
3. Llenar:
   - App name: `Equipo de Agentes - Facturación`
   - User support email: el email del cliente
   - Developer contact: el email del cliente (o el tuyo)
4. **Save and continue**
5. **Scopes**: dejar vacío (los scopes vienen del código). **Save and continue**
6. **Test users**: agregar el email del cliente. **Save and continue**
7. **Summary** → **Back to dashboard**

### A4. Crear OAuth Client (tipo Desktop, por ahora)

1. Sidebar → **APIs & Services → Credentials**
2. **+ Create credentials → OAuth client ID**
3. Application type: **Desktop app**
4. Name: `Equipo de Agentes - Facturación`
5. **Create**
6. Vas a ver un modal con **Client ID** y **Client Secret** — anótalos en un Notepad temporal:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

7. **OK** para cerrar

### A5. Correr setup-oauth localmente

Con esos 2 valores en el Notepad, en tu terminal:

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes/agentes/Equipo-facturacion
```

Crear archivo `.env.local` (o editar el existente) con:

```env
GOOGLE_CLIENT_ID=...el del paso A4...
GOOGLE_CLIENT_SECRET=...el del paso A4...
```

Correr el script (desde la raíz del repo `equipodegentes`):

```bash
cd c:/Users/TOMAS/Desktop/equipodegentes
npm run facturacion:setup-oauth
```

El script va a imprimir una URL larga. **Copia esa URL y mandasela al cliente** (o si están juntos, click sobre la URL).

### A6. El cliente autoriza

1. Cliente abre la URL en su browser
2. Click en su cuenta Google
3. Pantalla "Google no ha verificado esta app" → **Advanced → Go to ... (unsafe)**
4. Pantalla de permisos → **Continue / Allow**
5. El browser muestra "Listo"

En tu terminal, vas a ver impreso:

```
GOOGLE_OAUTH_REFRESH_TOKEN=1//abc123...
```

⚠️ Anota ese refresh_token en tu Notepad temporal. Empieza con `1//` (uno-slash-slash). **Si te queda con `=` al inicio, borralo.**

---

## Bloque B — Setup recursos del cliente (~5 min)

Necesitas el cliente todavía al lado.

### B1. Drive folder destino

1. Cliente abre Google Drive (https://drive.google.com)
2. **+ New → Folder** → nombre: `Facturas Tu-Empresa 2026`
3. Doble click sobre la carpeta para entrar
4. **Copiá la URL** del browser. Tiene formato:
   ```
   https://drive.google.com/drive/folders/1aB2cD3eF...
   ```
5. El **Drive Folder ID** es la última parte (después de `/folders/`):
   ```
   1aB2cD3eF...
   ```
6. Anotalo en el Notepad como `INVOICES_DRIVE_FOLDER_ID=...`

### B2. Sheet de control

1. Cliente abre Google Sheets (https://sheets.google.com)
2. **+ Blank**
3. Ponele nombre arriba: `Control de Facturas Tu-Empresa`
4. La pestaña por default se llama "Hoja 1" — renómbrala a `Gastos 2026` (doble-click sobre el nombre)
5. **Copiá la URL** del browser. Tiene formato:
   ```
   https://docs.google.com/spreadsheets/d/1xY2zA3bC.../edit
   ```
6. El **Sheet ID** es la parte entre `/d/` y `/edit`:
   ```
   1xY2zA3bC...
   ```
7. Anotalo en el Notepad como:
   ```
   INVOICES_SHEET_ID=1xY2zA3bC...
   INVOICES_SHEET_TAB=Gastos 2026
   ```

### B3. Email destino del resumen

Pregunta al cliente: ¿a qué email querés que llegue el resumen diario?

Anotalo:
```
NOTIFY_EMAIL_TO=cliente@suempresa.co
```

---

## Bloque C — Cargar credenciales en Netlify (single-tenant temporal)

> ⚠️ **Limitación temporal**: hasta que esté la Fase 2 del spec multi-tenant (credenciales en Supabase), Netlify solo soporta UN set de credenciales por sitio. Para sumar un segundo cliente, **hay que crear OTRO sitio Netlify** dedicado a ese cliente.

### C1. Crear sitio Netlify dedicado al cliente

1. https://app.netlify.com → **Add new site → Import an existing project → Deploy with GitHub**
2. Seleccionar repo `Tomasrv1992/equipodegentes`
3. Configuración:
   - **Branch**: `main` (o `feat/admin-panel` si todavía no hicimos merge)
   - **Project to deploy**: select "Other (configure manually)"
   - **Build command**: `npm install`
   - **Publish directory**: `public`
4. **Site name**: `equipodegentes-cron-<slug-cliente>` (ej `equipodegentes-cron-clinicaxyz`)
5. **NO clickees Deploy todavía**

### C2. Cargar las 11 env vars (con datos del cliente)

Igual que cuando creaste el cron tuyo, pero ahora con datos del cliente:

```env
GOOGLE_CLIENT_ID=A4 del cliente
GOOGLE_CLIENT_SECRET=A4 del cliente
GOOGLE_OAUTH_REFRESH_TOKEN=A6 del cliente (sin = al inicio)
INVOICES_DRIVE_FOLDER_ID=B1 del cliente
INVOICES_SHEET_ID=B2 del cliente
INVOICES_SHEET_TAB=Gastos 2026
FACTURACION_INTERNAL_SECRET=genera_uno_random_32_chars
RESEND_API_KEY=tu_resend_api_key (compartido con tu cron)
NOTIFY_EMAIL_TO=B3 del cliente
SUPABASE_URL=https://hzrwszqqkmipsimljfsr.supabase.co
SUPABASE_SERVICE_ROLE_KEY=tu_service_role_de_supabase
```

> 💡 El `FACTURACION_INTERNAL_SECRET` puede ser distinto por cliente (genera uno random tipo `openssl rand -hex 32` en terminal). El `RESEND_API_KEY` y `SUPABASE_*` son los mismos que tu cron — los compartes entre todos los sitios.

Marcar como Sensitive: `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `FACTURACION_INTERNAL_SECRET`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

### C3. Deploy

- Trigger deploy → esperar verde

---

## Bloque D — Agregar cliente al panel admin (~3 min)

Ahora el cliente existe en Netlify pero NO en Supabase. Hay que crearlo en el panel.

### D1. Insertar cliente en Supabase

Supabase SQL Editor → New query:

```sql
-- Reemplaza con datos reales del cliente
insert into public.clientes (nombre, slug, notas)
values ('Tu-Empresa', 'tu-empresa', 'Onboarded 2026-XX-XX. Sitio Netlify: equipodegentes-cron-xxx')
returning id;
```

Run. Anotá el `id` (uuid) que devuelve.

### D2. Activar agente facturación para el cliente

En el SQL Editor:

```sql
-- Usar el id del paso D1
insert into public.client_agents (cliente_id, agente_id, config, activo)
values (
  'PEGA_AQUI_ID_DEL_PASO_D1',
  'facturacion',
  jsonb_build_object(
    'sheet_id', 'B2 del cliente',
    'drive_folder', 'B1 del cliente',
    'notify_email', 'B3 del cliente',
    'cron', '0 12 * * *',
    'netlify_site', 'equipodegentes-cron-tu-empresa.netlify.app'
  ),
  true
);
```

### D3. Verificar en el panel admin

1. Abrí https://equipodegentes-admin.netlify.app
2. Refresh → vas a ver el cliente nuevo en la matriz
3. Celda Equipo-facturación dice "no activado" todavía (hasta que corra el primer cron)

---

## Bloque E — Validar con dry-run (~2 min)

PowerShell:

```powershell
$secret = "EL_FACTURACION_INTERNAL_SECRET_DEL_CLIENTE"
$siteUrl = "https://equipodegentes-cron-tu-empresa.netlify.app"
Invoke-RestMethod -Uri "$siteUrl/.netlify/functions/facturacion-background" -Method POST -Headers @{ "x-internal-secret" = $secret; "content-type" = "application/json" } -Body '{"dryRun": true}'
```

Esperás: 202 (background fn). Verificá en logs Netlify del sitio del cliente.

Refrescá el panel admin → la celda del cliente × facturación debería tener un dot 🟢 OK con timestamp reciente.

---

## ❓ Limitaciones del proceso manual

1. **Cliente tiene que estar disponible** (presencial o videocall) — no puede onboardearse solo
2. **Tomás necesita acceso temporal** a la cuenta Google del cliente (mientras corre A6)
3. **Un sitio Netlify nuevo por cada cliente** — caro y tedioso si llegan a 10+
4. **No hay reconexión OAuth** — si el refresh_token expira, hay que volver a hacer A5-A6 con el cliente

**Por eso necesitamos Fase 3 del spec multi-tenant (OAuth flow web del cliente).** Cuando lo implementemos, todo este manual se reduce a "Tomás click 'Nuevo cliente' → manda link → cliente completa solo".

---

## ✅ Checklist resumen

**Bloque A — OAuth setup** (~10 min, con cliente)
- [ ] A1 — Proyecto Google Cloud creado
- [ ] A2 — 3 APIs habilitadas (Gmail, Drive, Sheets)
- [ ] A3 — OAuth consent screen + cliente como test user
- [ ] A4 — OAuth Client Desktop creado, anotado client_id + secret
- [ ] A5 — `setup-oauth.mjs` corrido
- [ ] A6 — Cliente autorizó, refresh_token anotado

**Bloque B — Recursos** (~5 min, con cliente)
- [ ] B1 — Drive folder + folder_id anotado
- [ ] B2 — Sheet + sheet_id anotado
- [ ] B3 — Email destino confirmado

**Bloque C — Netlify** (~10 min)
- [ ] C1 — Sitio Netlify dedicado creado
- [ ] C2 — 11 env vars cargadas con datos del cliente
- [ ] C3 — Deploy verde

**Bloque D — Panel admin** (~3 min)
- [ ] D1 — Cliente insertado en `public.clientes`
- [ ] D2 — `client_agents` insertado con config
- [ ] D3 — Cliente visible en matriz

**Bloque E — Validación** (~2 min)
- [ ] E — Dry-run exitoso, dot verde en matriz
