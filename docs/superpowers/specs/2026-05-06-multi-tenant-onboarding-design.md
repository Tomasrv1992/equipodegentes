# Onboarding multi-tenant — Diseño

**Fecha:** 2026-05-06
**Autor:** Tomás Ramírez Villa (con Claude)
**Status:** Draft — pendiente review

---

## 1. Problema

Hoy el agente `Equipo-facturación` es **single-tenant**:
- Las credenciales (Google OAuth, Drive folder, Sheet ID, Resend key) viven en **env vars del sitio Netlify**
- Solo hay 1 cliente (Tomás)
- El cron diario procesa 1 sola cuenta de Gmail

Cuando vendamos el agente a un segundo cliente, no podemos simplemente
duplicar env vars — Netlify Site Configuration no permite múltiples sets
de env vars por cliente.

Necesitamos modelo multi-tenant donde:
- Cada cliente tiene sus propias credenciales aisladas
- El cron itera sobre clientes activos
- Onboarding es escalable (no manual cada vez)

## 2. Estado deseado

### 2.1 Flujo del cliente final

```
1. Tomás vende el agente a un cliente nuevo
2. Cliente recibe email de bienvenida con un link único
3. Cliente click → onboarding web minimalista
4. Cliente click "Conectar mi Google" → OAuth → autoriza
5. Cliente click "Conectar mi Drive folder" → selecciona carpeta destino
6. Cliente click "Conectar mi Sheet de control" → selecciona sheet
7. Cliente verifica email destino del resumen → confirma
8. Cliente recibe email "Listo, mañana 7am tu agente arranca"
9. Día siguiente: cron procesa Gmail del cliente, escribe a SU Drive y SU Sheet
10. Cliente recibe email diario con resumen
```

### 2.2 Flujo de Tomás (operación)

- Tomás abre panel admin → "Nuevo cliente"
- Llena: nombre, email, slug
- Sistema genera link de onboarding único
- Tomás copia el link y lo manda al cliente (WhatsApp, email)
- Una vez el cliente termine onboarding, aparece "Activo" en la matriz
- Si algo falla (OAuth caducó, etc), Tomás ve el error en la matriz y manda al cliente "click acá para reconectar"

## 3. Modelo de datos

### 3.1 Tabla nueva: `client_credentials`

Las credenciales viven en Supabase, **encriptadas** (no en env vars):

```sql
create table public.client_credentials (
  cliente_id uuid primary key references public.clientes(id) on delete cascade,
  agente_id text not null references public.agentes(id),

  -- Google OAuth (encriptado)
  google_refresh_token_encrypted bytea,
  google_oauth_status text default 'pending'
    check (google_oauth_status in ('pending', 'connected', 'expired', 'revoked')),
  google_email text,                 -- email de Google del cliente (info, no auth)

  -- Recursos del cliente
  drive_folder_id text,              -- carpeta donde van facturas
  drive_folder_name text,             -- "Facturas 2026" (para mostrar en UI)
  sheet_id text,
  sheet_tab text default 'Gastos 2026',

  -- Notificaciones
  notify_email text not null,         -- email destino del resumen diario
  resend_api_key_encrypted bytea,     -- (opcional) key propia del cliente

  -- Estado
  onboarded_at timestamptz,
  last_oauth_refresh timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.client_credentials enable row level security;
create policy "tomas_only" on public.client_credentials
  for all using ((auth.jwt() ->> 'email') = 'tomasramirezvilla@gmail.com');
```

### 3.2 Tabla nueva: `onboarding_tokens`

Tokens únicos para el flujo de onboarding del cliente (SIN auth Supabase —
el cliente NO loguea con magic link, accede via token URL):

```sql
create table public.onboarding_tokens (
  token text primary key,             -- 32 chars random, URL-safe
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  agente_id text not null references public.agentes(id),
  step text not null default 'pending'
    check (step in ('pending', 'oauth_done', 'resources_done', 'completed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  completed_at timestamptz
);
```

### 3.3 Encriptación de credenciales

**Decisión pendiente** (3 opciones):

**Opción A — Supabase Vault** ⭐ recomendado
- Feature nativa de Supabase (built on libsodium)
- Las claves de cifrado las gestiona Supabase
- API: `vault.create_secret(value, name, description)` retorna un UUID
- Las tablas almacenan el UUID (no el valor)
- Service role key puede leer; usuarios anon no
- Trade-off: requiere "Vault" addon, gratis en plan Pro

**Opción B — Cifrado con `pgcrypto`**
- Extensión gratis incluida en Supabase
- `pgp_sym_encrypt(value, key)` / `pgp_sym_decrypt(...)`
- La key vive en una env var del sitio cron (`VAULT_KEY`)
- Pro: gratis. Contra: la key está en env var (si Netlify se compromete, todo se pierde)

**Opción C — Cifrado en aplicación (Node)**
- `crypto.createCipheriv('aes-256-gcm', ...)` antes de insertar
- La key en env var
- Mismo trade-off que B pero con menos magia

**Recomendación**: empezar con **B (`pgcrypto`)** por simplicidad. Migrar a Vault si Supabase eleva al plan Pro.

## 4. Arquitectura técnica

### 4.1 OAuth client de Google — cambio crítico

Hoy: cliente tipo **"Desktop"** que redirige a `localhost:53682/callback`.

Multi-tenant: cliente tipo **"Web application"** que redirige a:
`https://equipodegentes-admin.netlify.app/auth/google/callback`

Esto requiere:
1. En Google Cloud Console → crear nuevo OAuth Client (tipo Web app)
2. Authorized JavaScript origins: `https://equipodegentes-admin.netlify.app`
3. Authorized redirect URIs: `https://equipodegentes-admin.netlify.app/auth/google/callback`
4. Esos client_id/secret van en env vars del sitio admin (UNO solo, compartido entre todos los clientes — los refresh_tokens son lo que cambia por cliente)

**No se reutiliza** el OAuth client Desktop existente. Las apps deben estar en modo **Production** (no Testing) para que cualquier email pueda autorizar — eso requiere verificación de Google si los scopes son sensibles. Gmail.modify ES sensible. Workaround inicial: **mantener en Testing y agregar emails de clientes como Test Users** (límite 100, suficiente para empezar).

### 4.2 Flow de onboarding step-by-step

#### Paso 1 — Tomás crea el cliente
- Panel admin → "Nuevo cliente"
- Form: nombre, email del cliente, agentes a activar
- Backend: INSERT `clientes`, INSERT `client_agents`, generate `onboarding_token`
- Retorna: link de onboarding `https://equipodegentes-admin.netlify.app/onboarding/<token>`

#### Paso 2 — Tomás manda el link al cliente
- Por ahora: copy/paste a WhatsApp o email manual
- Futuro: botón "Enviar email" que dispara Resend con plantilla de bienvenida

#### Paso 3 — Cliente abre el link
- Página pública (NO requiere login Supabase)
- El token valida por 7 días
- Muestra: "Hola [nombre], vamos a conectar tu cuenta para [servicio]"
- Botón "Conectar Google"

#### Paso 4 — OAuth Google
- Click "Conectar Google" → redirect a Google con `state=<token>` y scopes Gmail/Drive/Sheets
- Google → consentimiento → callback a `/auth/google/callback?code=X&state=<token>`
- Edge function valida token, intercambia code por refresh_token
- Guarda refresh_token encriptado en `client_credentials`
- Marca `google_oauth_status = 'connected'`
- Redirect a paso 5

#### Paso 5 — Selección de Drive folder + Sheet
- Página: "¿Dónde quieres que guarde tus facturas?"
- Componente: file picker estilo Google Picker API (o lista simple via Drive API)
- Cliente selecciona carpeta → guarda `drive_folder_id` + `drive_folder_name`
- Cliente selecciona Sheet → guarda `sheet_id`
- Marca step `resources_done`

#### Paso 6 — Confirmación
- Página: "Listo. El agente arranca mañana 7am Bogotá."
- Marca `step = 'completed'`, `onboarded_at = now()`
- Email de welcome al cliente
- Email a Tomás: "Cliente X completó onboarding"

### 4.3 Cambios en el cron

Modificar `facturacion-cron.mts`:
1. Lee de Supabase: `select cliente_id, agente_id from client_agents where activo = true and agente_id = 'facturacion'`
2. Para cada cliente activo: dispara la background fn con `{ clienteId, customerSlug }`
3. Background fn lee credenciales de `client_credentials` (decrypt), construye `PipelineConfig`, ejecuta `run(cfg)`

### 4.4 Cambios en `facturacion-background.mts`

Modificar `buildConfig()`:
- Si `body.customerId` viene → query `client_credentials` con service role + decrypt → construir cfg desde DB
- Si no viene → mantener path actual de env vars (compatibilidad single-tenant)

## 5. Plan de implementación por fases

### Fase 1 — Lo que se puede hacer YA (sin OAuth flow)

Trabajo 100% local + UI panel. No toca producción.

1. ✅ Pantalla "Nuevo cliente" en panel admin (form)
2. ✅ Manual `MANUAL-AGREGAR-CLIENTE.md` para que Tomás onboardée clientes hoy haciendo el OAuth setup él mismo
3. ✅ Pantalla "Editar cliente" para actualizar config del client_agent

**Output**: Tomás puede agregar clientes desde la UI, pero el onboarding es manual (Tomás corre `setup-oauth.mjs` con cada cliente).

### Fase 2 — Multi-tenant en código

1. Crear migración `0002_client_credentials.sql`
2. Migración `0003_onboarding_tokens.sql`
3. Modificar `buildConfig()` para leer de Supabase si `customerId` viene
4. Modificar `facturacion-cron.mts` para iterar sobre clientes activos
5. Insertar las credenciales actuales de Tomás en `client_credentials` (single-row)
6. Probar end-to-end: cron itera, lee credenciales, ejecuta

**Output**: el cron funciona idéntico a hoy pero leyendo credenciales de Supabase. Single-tenant pasa a multi-tenant a nivel de código.

### Fase 3 — OAuth flow del cliente

1. Crear nuevo OAuth Client Google tipo Web Application
2. Agregar env vars en sitio admin
3. Crear edge functions: `/auth/google/start`, `/auth/google/callback`
4. Crear ruta `/onboarding/:token` en panel admin
5. Página de selección de Drive folder + Sheet
6. Email de welcome via Resend

**Output**: cliente nuevo se onboardea solo con un link. Tomás solo crea el cliente y manda el link.

### Fase 4 — Polish

- Email automático al crear cliente (no copy/paste)
- Notificación a Tomás cuando un cliente completa onboarding
- Reconexión de OAuth (cuando expira el token)
- Dashboard de métricas por cliente

## 6. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Credenciales se filtran si Netlify se compromete | Cifrado con pgcrypto + key en env var separada por servicio. Service_role key con scope mínimo. |
| Cliente revoca OAuth en Google → cron falla todos los días | Detectar `invalid_grant`, marcar `google_oauth_status='expired'`, mandar email "reconecta acá" + mostrar warn en panel. |
| Google Cloud OAuth en modo Testing solo permite 100 test users | Aceptable hasta 100 clientes. Después, verificación oficial de Google (2-6 semanas). |
| Multi-tenant rompe el cron actual mientras se prueba | Implementar con feature flag — si la query a `client_credentials` no devuelve filas, fallback a env vars. |

## 7. Open questions

- **Encriptación de credenciales**: ¿pgcrypto o Vault de Supabase? (decisión inicial: pgcrypto)
- **OAuth client de Google**: ¿creamos un cliente Web nuevo o reutilizamos el Desktop existente? (decisión: nuevo Web)
- **Modo Production en Google**: ¿esperar verificación oficial o quedarse en Testing limitado a 100 users? (decisión inicial: Testing por simplicidad)
- **Plan Resend**: ¿free tier (100 emails/día) alcanza? Si más de 100 clientes, upgrade a $20/mes
- **Pricing**: ¿cómo cobramos al cliente? Mensual fijo, comisión por factura procesada, etc. (fuera de alcance técnico — decisión de negocio)
