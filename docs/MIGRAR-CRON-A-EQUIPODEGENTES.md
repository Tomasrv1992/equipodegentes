# Migrar el cron de facturación: consultoria-ea → equipodegentes

> Objetivo: que el cron diario que procesa facturas DIAN deje de correr en el sitio Netlify de `consultoria-ea` y pase a correr en un sitio Netlify dedicado del repo `equipodegentes`. Como bonus, este sitio nuevo SÍ está conectado al Supabase del panel admin, así que cada corrida diaria va a aparecer automáticamente en la matriz.

> 🕐 Tiempo total: **~30-40 min**. La parte más larga es copiar 11 env vars del sitio viejo al nuevo (5-10 min de copy/paste).

---

## Por qué hacer esto

Hoy hay 2 problemas:

1. **Código viejo en producción**: el cron que corre en `consultoria-ea` usa el código del repo `consultoria-app` (sin la instrumentación a Supabase que agregamos al repo `equipodegentes`). Por eso la matriz del panel admin se ve vacía aunque el cron esté corriendo todos los días.

2. **Acoplamiento conceptual**: el negocio de "agentes para PYMEs" no debería vivir en el repo del negocio de "consultoría". Mezclados, pero independientes — toca separarlos.

**Estado al final de este manual:**
- Sitio Netlify nuevo `equipodegentes-cron` corriendo el cron desde el repo `equipodegentes`, branch `feat/admin-panel` (después `main`)
- Sitio viejo `consultoria-ea` con el cron **apagado** (la web sigue funcionando, solo no ejecuta más la function `facturacion-cron`)
- Cada corrida del cron escribe automáticamente a Supabase y aparece en la matriz del panel admin

---

## Lista de env vars que vas a copiar

Tenés que sacar estas **11 vars** del sitio viejo (`consultoria-ea`) y pegarlas en el sitio nuevo (`equipodegentes-cron`). De las 11, **2 son nuevas** (no existen en el viejo) — las agregás manualmente.

| Var | Sensitive | Origen |
|---|---|---|
| `GOOGLE_CLIENT_ID` | No | Copiar del sitio viejo |
| `GOOGLE_CLIENT_SECRET` | **Sí ⚠️** | Copiar del sitio viejo |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | **Sí ⚠️** | Copiar del sitio viejo (cuidado con el `=` extra al inicio) |
| `INVOICES_DRIVE_FOLDER_ID` | No | Copiar del sitio viejo |
| `INVOICES_SHEET_ID` | No | Copiar del sitio viejo |
| `INVOICES_SHEET_TAB` | No | Copiar del sitio viejo (probablemente `Gastos 2026`) |
| `FACTURACION_INTERNAL_SECRET` | **Sí ⚠️** | Copiar del sitio viejo |
| `RESEND_API_KEY` | **Sí ⚠️** | Copiar del sitio viejo |
| `NOTIFY_EMAIL_TO` | No | Copiar del sitio viejo (probablemente `tomasramirezvilla@gmail.com`) |
| `NOTIFY_EMAIL_FROM` | No | Copiar del sitio viejo (opcional, default ya hay) |
| `SUPABASE_URL` | No | **NUEVA** — la del proyecto Supabase admin |
| `SUPABASE_SERVICE_ROLE_KEY` | **Sí ⚠️** | **NUEVA** — del proyecto Supabase admin |

> 💡 Las 2 nuevas (`SUPABASE_*`) son las del proyecto `equiposdegentes.prod` que creaste ayer. Las tenés en el `.txt` temporal del paso 2 del manual `DEPLOY-PRIMER-CLIENTE.md`.

---

## Bloque A — Crear sitio Netlify nuevo (~5 min)

### A1. Add new site

- https://app.netlify.com → **Add new site → Import an existing project → Deploy with GitHub**
- Buscar y seleccionar el repo `Tomasrv1992/equipodegentes`
- ⚠️ ESTE ES UN SITIO DISTINTO al `equipodegentes-admin`. Vas a tener 2 sitios del mismo repo: uno para el cron (raíz del repo) y otro para el panel (subcarpeta `apps/admin`).

### A2. Build settings

| Campo | Valor |
|---|---|
| **Branch to deploy** | `feat/admin-panel` (cuando hagas merge a main, lo cambias) |
| **Base directory** | (vacío — raíz del repo) |
| **Build command** | `npm install` |
| **Publish directory** | `public` |

> El `public` lo dice el `netlify.toml` de la raíz. Aunque la carpeta no exista, Netlify la crea vacía y publica un sitio "vacío" — eso está OK porque acá solo nos importan las **functions**, no el sitio web.

### A3. Site name

- `equipodegentes-cron` (o como prefieras)
- ⚠️ NO clickees Deploy site todavía. Vas a configurar env vars primero.

---

## Bloque B — Copiar las 11 env vars del sitio viejo (~10-15 min)

### B1. Abrir las 2 pestañas en paralelo

Abrí 2 pestañas del browser:
- **Pestaña A**: sitio viejo `consultoria-ea` → **Site configuration → Environment variables**
- **Pestaña B**: sitio nuevo `equipodegentes-cron` → **Site configuration → Environment variables**

### B2. Copiar una por una

Para cada una de las 9 vars que ya existen en el viejo:

1. **Pestaña A** → click en la var → click ícono de ojo 👁 para revelar valor → copy
2. **Pestaña B** → **Add a variable → Add a single variable**
3. Pegar el `Key` (mismo nombre exacto) y el `Value`
4. Si es Sensitive (ver tabla arriba), marcar el toggle correspondiente
5. **Save**

Vars a copiar del viejo al nuevo:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET` ⚠️
- `GOOGLE_OAUTH_REFRESH_TOKEN` ⚠️
- `INVOICES_DRIVE_FOLDER_ID`
- `INVOICES_SHEET_ID`
- `INVOICES_SHEET_TAB`
- `FACTURACION_INTERNAL_SECRET` ⚠️
- `RESEND_API_KEY` ⚠️
- `NOTIFY_EMAIL_TO`
- `NOTIFY_EMAIL_FROM` (si existe)

> ⚠️ **Cuidado especial con `GOOGLE_OAUTH_REFRESH_TOKEN`**: el valor real empieza con `1//`. Si al copiar te queda `=1//` (con un `=` adelante), borralo — es el típico bug del README. Causa "invalid_grant" silencioso.

### B3. Agregar las 2 vars NUEVAS (Supabase)

En el sitio nuevo:

| Key | Value | Sensitive |
|---|---|---|
| `SUPABASE_URL` | `https://hzrwszqqkmipsimljfsr.supabase.co` (la del proyecto admin) | No |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key del proyecto admin | **Sí ⚠️** |

### B4. Verificar que están las 11

En el sitio nuevo, hacer scroll por la lista de env vars y contar. Debe haber 11 (10 si `NOTIFY_EMAIL_FROM` no existía en el viejo, eso está OK).

---

## Bloque C — Trigger primer deploy (~3 min)

### C1. Deploy

- Sitio nuevo → **Deploys → Trigger deploy → Deploy site**
- Esperar ~2-3 min

**Esperás:** "Published" en verde.

**Si falla**: mandame los últimos 30 logs.

### C2. Verificar que las functions se desplegaron

- Sitio nuevo → sidebar **Logs → Functions**
- Tenés que ver listadas:
  - `facturacion-cron` ← ⏰ scheduled (0 12 * * *)
  - `facturacion-background` ← worker
  - `record-run` ← endpoint para Python
- Si no las ves, el deploy parseó mal — mandame screenshot

---

## Bloque D — Disparar manualmente y validar (~5 min)

### D1. Disparar dry-run

PowerShell en `c:/Users/TOMAS/Desktop/equipodegentes`:

```powershell
$secret = "PEGA_FACTURACION_INTERNAL_SECRET"
$siteUrl = "https://equipodegentes-cron.netlify.app"  # tu sitio nuevo
Invoke-RestMethod -Uri "$siteUrl/.netlify/functions/facturacion-background" `
  -Method POST `
  -Headers @{ "x-internal-secret" = $secret; "content-type" = "application/json" } `
  -Body '{"dryRun": true}'
```

**Esperás:** JSON `{ ok: true, durationMs: ___, runId: "uuid-..." }`.

**Si falla:**
- 401 unauthorized → secret mal pegado
- 500 internal error → revisar logs Netlify del sitio nuevo → Functions → `facturacion-background`
- Si dice "invalid_grant" → el refresh token tiene `=` al inicio o expiró

### D2. Verificar en Supabase

```sql
select id, status, summary, started_at, finished_at, triggered_by
from public.agent_runs
order by started_at desc
limit 1;
```

Debe haber una nueva fila con `status='ok'` o `'warn'` (ok si es dryRun).

### D3. Verificar en el panel admin

- Abrí el panel `https://equipodegentes-admin.netlify.app`
- Refresca → la matriz **Owner × Equipo-facturación** ahora tiene un dot 🟢 con timestamp reciente
- Click en la celda → ves el detalle del run

🎯 **Si llegaste a este punto = todo funciona end-to-end**. El cron nuevo escribe a Supabase y se refleja en el panel.

---

## Bloque E — Apagar el cron viejo en consultoria-ea (~3 min)

⚠️ **Solo después de validar Bloque D**. No lo hagas antes — si Bloque D falla, querés mantener el cron viejo corriendo para no quedarte sin facturas.

### E1. Opción suave: deshabilitar la function viejo

- Sitio viejo `consultoria-ea` → sidebar **Functions** o **Logs → Functions**
- Buscar `facturacion-cron` → click → **Disable scheduling** (si Netlify lo permite)

### E2. Opción dura: borrar las functions del repo viejo

Si la opción E1 no aparece o no funciona, borrá las functions del repo `consultoria-app`:

```bash
cd c:/Users/TOMAS/Desktop/consultoria-app
git rm netlify/functions/facturacion-cron.mts
git rm netlify/functions/facturacion-background.mts
# si tiene la lib pipeline también:
git rm -r agentes/Equipo-facturacion  # CUIDADO: solo si ese path existe en consultoria-app
```

Commit + push → re-deploy automático del sitio viejo. Las functions desaparecen.

⚠️ NO toques las env vars del sitio viejo todavía — dejalas como respaldo por si necesitamos revertir.

### E3. Confirmar

- Sitio viejo → sidebar **Functions** → ya no debe listar `facturacion-cron`
- A las 7am COT del día siguiente, la única corrida del cron debe ser la del sitio nuevo

---

## Bloque F — Verificar el primer cron automático (mañana 7:00 COT)

Sin acción tuya. Solo abrir el panel mañana después de las 7:01am Bogotá:

- Refrescar la matriz → debería haber un run nuevo del día actual con timestamp ~7:00 am
- Si no aparece, ir al sitio nuevo Netlify → Logs → Functions → `facturacion-cron` → ver si se ejecutó

---

## ❓ Si algo falla

Mandame:
1. Bloque y paso que falló
2. Error literal copy/paste
3. Screenshot si es UI

---

## ✅ Checklist resumen

**Bloque A — Sitio nuevo** (~5 min)
- [ ] A1 — Sitio creado desde GitHub
- [ ] A2 — Build settings configurados (raíz del repo)
- [ ] A3 — Site name `equipodegentes-cron`

**Bloque B — Env vars** (~10-15 min)
- [ ] B1 — 2 pestañas abiertas en paralelo
- [ ] B2 — 9 vars copiadas del viejo al nuevo
- [ ] B3 — 2 vars nuevas (Supabase) agregadas
- [ ] B4 — 11 vars confirmadas

**Bloque C — Deploy** (~3 min)
- [ ] C1 — Primer deploy verde
- [ ] C2 — 3 functions visibles (`facturacion-cron`, `facturacion-background`, `record-run`)

**Bloque D — Validación** (~5 min)
- [ ] D1 — POST manual a `facturacion-background` retorna `ok: true`
- [ ] D2 — Fila aparece en `agent_runs`
- [ ] D3 — Run aparece en la matriz del panel admin

**Bloque E — Apagar viejo** (~3 min)
- [ ] E1 o E2 — Cron viejo deshabilitado
- [ ] E3 — Function ya no aparece en consultoria-ea

**Bloque F — Verificación automática** (mañana 7:01 COT)
- [ ] Run del día aparece en la matriz sin acción manual
