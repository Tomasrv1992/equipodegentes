# Activar Fase 3 — Onboarding multi-tenant via OAuth

> Manual consolidado para Tomás. Todo el código de Fase 3 ya está pusheado en `feat/admin-panel`. Este manual lista las **5 acciones manuales** que necesitás hacer para activarlo. Tiempo total: ~25 minutos.
>
> Al final del manual, vas a poder click "Crear link de onboarding" en la ficha de un cliente, mandarle el link al cliente, y el cliente solito conecta su Google + elige Drive folder + Sheet. Cron diario itera sobre todos los clientes activos automáticamente.

---

## Pre-requisitos

- Branch `feat/admin-panel` con todos los commits hasta `Fase 3 completa` ya pusheados
- Sitio `equipodegentes-admin` deployado y accesible (la última build incluye `/onboarding/:token`)
- Sitio `equipodegentes-cron` deployado con env vars de Supabase ya configuradas (Sesión anterior)
- Acceso a:
  - Supabase Dashboard del proyecto `equiposdegentes.prod`
  - Google Cloud Console con tu cuenta `tomasramirezvilla@gmail.com`
  - Netlify Dashboard (sitios `equipodegentes-admin` y `equipodegentes-cron`)
  - PowerShell (para generar la vault key)

---

## Bloque A — Correr migración SQL en Supabase (~3 min)

### A1. Abrir SQL Editor

- https://supabase.com/dashboard → proyecto `equiposdegentes.prod`
- Sidebar → ícono `>_` (SQL Editor)
- Click **+ New query**

### A2. Pegar el SQL completo

- Abrí en VS Code: `docs/superpowers/migrations/0002_client_credentials_and_onboarding.sql`
- Seleccioná todo el contenido (Ctrl+A → Ctrl+C)
- Pegá en el SQL Editor de Supabase

### A3. Ejecutar

- Click el botón verde **Run** abajo a la derecha (o Ctrl+Enter)
- Esperá ~3 segundos

**Esperás ver:** `Success. No rows returned`

**Si falla:**
- "extension pgcrypto already exists" → safe, ignorar
- "table already exists" → la migración ya corrió, safe ignorar
- Otra cosa → mandame screenshot

### A4. Verificar que las tablas se crearon

Pegá en una nueva query y Run:

```sql
select 'client_credentials' as tabla, count(*) as filas from public.client_credentials
union all
select 'onboarding_tokens', count(*) from public.onboarding_tokens;
```

Esperás 2 filas con `0` y `0` (tablas vacías).

---

## Bloque B — Generar Vault Key para encriptar refresh tokens (~1 min)

### B1. Abrir PowerShell

Tecla Windows ⊞ → tipear `powershell` → Enter

### B2. Generar la key

Pegá EXACTAMENTE este comando y Enter:

```powershell
[System.Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

Vas a ver impreso un string de 64 caracteres hex (mayúsculas + dígitos). Algo así:

```
A3F9B2C7D1E84F62...
```

### B3. Guardalo en tu Notepad temporal con etiqueta

```
CREDENTIALS_VAULT_KEY=A3F9B2C7D1E84F62...
```

> ⚠️ **MUY IMPORTANTE**: esta key encripta los refresh tokens de TODOS los clientes. **Si la perdés**, todos los refresh tokens guardados pasan a ser ilegibles y todos los clientes tienen que volver a hacer onboarding. Guardala también en password manager (1Password, Bitwarden).

---

## Bloque C — Crear OAuth Client tipo Web en Google Cloud (~10 min)

> Este OAuth Client es **distinto** al "Desktop" que usaste para tu propio cron single-tenant. Va a ser el client compartido que TODOS los clientes de Operatto usan al autorizar.

### C1. Ir a Google Cloud Console

- https://console.cloud.google.com
- Asegurate de estar en el proyecto que ya tenés con las APIs habilitadas (Gmail/Drive/Sheets API)
- Si necesitás crear uno nuevo: New Project → name `operatto-prod` → habilitar Gmail/Drive/Sheets API

### C2. Configurar OAuth consent screen (si todavía no lo hiciste)

- Sidebar → **APIs & Services → OAuth consent screen**
- Si dice "Get started" o no está configurado:
  - **External** → Create
  - **App name**: `Operatto`
  - **User support email**: `tomasramirezvilla@gmail.com`
  - **App logo**: (opcional, podés subir más tarde)
  - **Application home page**: `https://equipodegentes-admin.netlify.app`
  - **Authorized domains**: `netlify.app`
  - **Developer contact**: `tomasramirezvilla@gmail.com`
  - Save and continue
- **Scopes**: dejar vacío (los scopes los maneja el código)
- **Save and continue**
- **Test users**: agregá los emails de los primeros clientes que vas a onboardear (incluido el tuyo). Hasta 100 max en modo Testing.
- Save and continue → Back to dashboard

> 💡 **Modo Testing es OK por ahora**. Permite hasta 100 test users. Cuando llegues a 50+ clientes, postular a verificación oficial de Google (gratis pero 2-6 semanas de revisión).

### C3. Crear OAuth Client ID tipo Web

- Sidebar → **APIs & Services → Credentials**
- Click **+ Create credentials → OAuth client ID**
- **Application type**: **Web application** ⚠️ (NO "Desktop"; el viejo era Desktop, este es DIFERENTE)
- **Name**: `Operatto Web Client (clientes)`
- **Authorized JavaScript origins** → click **+ ADD URI**:
  ```
  https://equipodegentes-admin.netlify.app
  ```
- **Authorized redirect URIs** → click **+ ADD URI**:
  ```
  https://equipodegentes-admin.netlify.app/api/auth/google/callback
  ```
- **CREATE**
- Vas a ver un modal con **Client ID** y **Client Secret**
- Copialos a tu Notepad temporal:

```
GOOGLE_OAUTH_WEB_CLIENT_ID=........apps.googleusercontent.com
GOOGLE_OAUTH_WEB_CLIENT_SECRET=GOCSPX-..........
```

- **OK** para cerrar el modal

---

## Bloque D — Configurar env vars en Netlify (~5 min)

Hay que agregar las nuevas vars en **2 sitios distintos**: `equipodegentes-admin` (frontend + edge fns) y `equipodegentes-cron` (background fn del agente).

### D1. Sitio `equipodegentes-admin`

- https://app.netlify.com → click sitio `equipodegentes-admin`
- Sidebar → **Site configuration → Environment variables**
- **Add a variable** (una por una):

| Key | Value | Sensitive |
|---|---|---|
| `GOOGLE_OAUTH_WEB_CLIENT_ID` | (de C3) | No |
| `GOOGLE_OAUTH_WEB_CLIENT_SECRET` | (de C3) | **Sí ⚠️** |
| `CREDENTIALS_VAULT_KEY` | (de B2) | **Sí ⚠️** |
| `ADMIN_SITE_URL` | `https://equipodegentes-admin.netlify.app` | No |

- Guardar
- Sidebar → **Deploys → Trigger deploy → Clear cache and deploy site**
- Esperar verde

### D2. Sitio `equipodegentes-cron`

- Vuelta al dashboard → click sitio `equipodegentes-cron`
- Sidebar → **Site configuration → Environment variables**
- **Add a variable**:

| Key | Value | Sensitive |
|---|---|---|
| `GOOGLE_OAUTH_WEB_CLIENT_ID` | (mismo de D1) | No |
| `GOOGLE_OAUTH_WEB_CLIENT_SECRET` | (mismo de D1) | **Sí ⚠️** |
| `CREDENTIALS_VAULT_KEY` | (mismo de D1) | **Sí ⚠️** |

> Las dos vars `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya las tiene este sitio (las pusiste en sesiones anteriores).

- Guardar
- Sidebar → **Deploys → Trigger deploy → Clear cache and deploy site**
- Esperar verde

---

## Bloque E — Probar el flujo end-to-end (~5 min)

### E1. Crear un cliente de prueba

Si querés probar con un cliente nuevo (sin pisar Owner):

- Abrí `https://equipodegentes-admin.netlify.app`
- Click **+ Nuevo cliente**
- Nombre: `Test Cliente 1`
- Slug: auto (queda `test-cliente-1`)
- Marcá **Equipo-facturación** como activo
- Los campos sheet/drive/etc se pueden dejar vacíos por ahora — el cliente los va a llenar via OAuth
- Click **Crear cliente**

> ⚠️ Esta prueba la podés hacer con tu mismo email (`tomasramirezvilla@gmail.com`). Solo tiene que estar agregado como Test User en el OAuth consent screen (paso C2).

### E2. Generar link de onboarding

Estás en la ficha del nuevo cliente.

- En la card de **Equipo-facturación**, vas a ver el botón **"Crear link de onboarding"**
- Click → genera el link y lo copia al portapapeles automáticamente
- El link queda visible en pantalla, algo así:
  ```
  https://equipodegentes-admin.netlify.app/onboarding/AbC123XyZ...
  ```

### E3. Abrir el link como si fueras el cliente

- Abrí el link en una **ventana de incógnito** (Ctrl+Shift+N) — para simular que sos un user sin login
- Vas a ver: "Hola Test Cliente 1, vamos a conectar tu cuenta de Google…"
- Click **Conectar mi cuenta Google**
- Google te lleva a la pantalla de consentimiento
  - Si dice "Google no ha verificado esta app" → click **Advanced → Go to Operatto (unsafe)** (es por estar en Modo Testing, normal)
- Click **Allow** en los permisos (Gmail/Drive/Sheets)
- Volvés al onboarding en step 2: **Elegí dónde guardar las facturas**
- Vas a ver:
  - Lista de carpetas Drive (las que tenés en root) → seleccioná una
  - Lista de Google Sheets → seleccioná uno
  - Email para resumen → opcional
- Click **Listo, terminar onboarding**
- Vas a ver pantalla de éxito ✅

### E4. Verificar en el panel admin

- Volvé a `https://equipodegentes-admin.netlify.app`
- Click en el cliente `Test Cliente 1`
- En la card de Equipo-facturación deberías ver:
  - 🟢 **Conectado** · email del cliente · onboarded fecha
  - Status correcto, drive folder y sheet seleccionados

### E5. Disparar manualmente un run para ese cliente

PowerShell:

```powershell
$secret = "TU_FACTURACION_INTERNAL_SECRET"
$siteUrl = "https://equipodegentes-cron.netlify.app"
Invoke-RestMethod -Uri "$siteUrl/.netlify/functions/facturacion-background" -Method POST -Headers @{ "x-internal-secret" = $secret; "content-type" = "application/json" } -Body '{"customerId":"test-cliente-1","dryRun":true}'
```

(Reemplazá `TU_FACTURACION_INTERNAL_SECRET` con el secret real.)

**Esperás:** background fn arranca. En logs Netlify del sitio cron vas a ver:
- `recordRunStart` exitoso
- `level: result` con números

**Verificá en Supabase:**

```sql
select status, summary, started_at
from public.agent_runs
where cliente_id = (select id from public.clientes where slug = 'test-cliente-1')
order by started_at desc limit 1;
```

Tiene que haber 1 fila con `status = 'ok'` o `'warn'`.

### E6. Verificar en panel admin

- Refrescar el panel
- En la matriz tiene que aparecer **Test Cliente 1 × Equipo-facturación · OK · 1m**

🎯 **Si llegaste a este punto = Fase 3 está activa**. El cron diario va a iterar sobre TODOS los clientes con OAuth conectado mañana 7am, automáticamente.

---

## Bloque F — Cuando vendas el primer cliente real

1. Panel admin → **+ Nuevo cliente** → llenar nombre + email + activar Equipo-facturación
2. En la ficha del cliente → **Crear link de onboarding**
3. Mandale el link al cliente (WhatsApp, email)
4. Cliente click el link → conecta Google → elige carpeta + sheet → ✅ listo
5. Mañana 7am Bogotá: cron procesa sus facturas automáticamente
6. Cliente recibe email con el resumen (si llenó el campo de email destino)

⚠️ **Acción requerida 1× por cliente**: agregar su email como Test User en Google Cloud → OAuth consent screen → Test users → ADD USERS. Esto es porque seguís en Modo Testing. Cuando subas a verificación oficial, esto deja de ser necesario.

---

## ❓ Si algo falla

| Síntoma | Causa probable | Fix |
|---|---|---|
| Onboarding link dice "inválido o vencido" | token > 7 días | Crear nuevo link |
| OAuth callback redirige con `error=no_refresh_token` | cliente ya autorizó antes | Revocar en myaccount.google.com/permissions y volver a conectar |
| OAuth callback redirige con `error=oauth_exchange_failed` | client_secret mal configurado en Netlify | Revisar D1/D2 |
| Status del cliente queda en "Esperando que el cliente complete onboarding" después de OAuth | callback falló silencioso | Revisar logs Netlify del sitio admin → edge fn auth-google-callback |
| Cron no procesa al nuevo cliente | falta `CREDENTIALS_VAULT_KEY` en sitio cron | Bloque D2 |
| "Cliente con slug X no tiene credenciales" | OAuth callback falló al guardar | Revisar logs Netlify edge fn |

---

## ✅ Checklist resumen

**Bloque A — Supabase migration** (~3 min)
- [ ] A1-A3 — SQL pegado y ejecutado
- [ ] A4 — Tablas verificadas

**Bloque B — Vault key** (~1 min)
- [ ] B1-B3 — Generada y guardada

**Bloque C — Google Cloud OAuth Client Web** (~10 min)
- [ ] C1 — En el proyecto correcto
- [ ] C2 — OAuth consent screen + test users
- [ ] C3 — Web client creado, ID + Secret copiados

**Bloque D — Netlify env vars** (~5 min)
- [ ] D1 — 4 vars en `equipodegentes-admin` + redeploy
- [ ] D2 — 3 vars en `equipodegentes-cron` + redeploy

**Bloque E — Test end-to-end** (~5 min)
- [ ] E1-E2 — Cliente creado y link generado
- [ ] E3 — Onboarding completado en incognito
- [ ] E4 — Status "Conectado" en panel
- [ ] E5-E6 — Run manual exitoso, aparece en matriz

**Bloque F — Onboarding del primer cliente real**
- [ ] Cuando lo vendás
