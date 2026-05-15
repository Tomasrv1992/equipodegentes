# Playbook de agentes — qué hace cada uno y cómo diagnosticar fallas

Última actualización: 2026-05-15 (sesión overnight 14→15 may).

## Arquitectura actual

Hay **4 agentes** corriendo en cron diario (más el cron de facturación que es la fuente de datos):

| Agente | Hora Bogotá | Hora UTC | Cron file | Rol |
|---|---|---|---|---|
| **Facturación** | 07:00 | 12:00 | `facturacion-cron.mts` | Procesa Gmail→Drive→Sheet, crea agent_events |
| **Inspector** | 08:00 | 13:00 | `inspector-cron.mts` | Observa runs del día, cierra zombies, costo Anthropic |
| **Archivero** | 08:15 | 13:15 | `archivero-cron.mts` | Coordina cross-check 5-fuentes + auto-repara + LLM recovery + cleanup |
| **Supervisor** | 08:45 | 13:45 | `supervisor-cron.mts` | Audita resultado final, dispara retriggers, anti-loop |

**Renombres recientes (2026-05-15):**
- `Equipo-monitor` → `Equipo-inspector` (para no confundir con supervisor)
- `Equipo-reparador` + `Equipo-limpiador` → `Equipo-archivero` (coordinador único)

**Crons deprecados pero presentes (rollback):**
- `monitor-cron.mts`: schedule `0 0 31 2 *` (31-feb, nunca corre) — reemplazado por inspector-cron
- `reparador-cron.mts`: schedule `0 0 31 2 *` — reemplazado por archivero-cron
- `limpiador-cron.mts`: schedule `0 0 31 2 *` — reemplazado por archivero-cron

---

## Flujo del día

```
07:00  facturacion-cron dispara facturacion-background (11 clientes con stagger 800ms)
         ├─ Cada cliente: preflight → fan-out por mes (si first_run) → procesa Gmail
         └─ Resultado: events en Supabase + filas en Sheet + PDFs en Drive

08:00  inspector-cron dispara inspector-background
         ├─ Para cada cliente: leer último run, marcar zombies (running >30min)
         └─ Suma costo Anthropic, detecta OAuth expirados, email diario (off por default)

08:15  archivero-cron dispara archivero-background
         ├─ runReparador(): completa Sheet desde events, match huérfanos por filename, valida 5-fuentes
         └─ runLimpiador(): LLM recovery huérfanos sin match, cleanup duplicados, basura
         Resultado: agent_run con agente_id='archivero', payload consolidado

08:45  supervisor-cron dispara supervisor-background
         ├─ Para cada cliente: chequea gaps Drive/Sheet/Events
         ├─ Si hay gaps → retrigger archivero (con anti-loop por agente)
         └─ Escalación intervención humana si saturan los retriggers
```

Cada agente registra UN `agent_run` con `agente_id` ∈ {facturacion, inspector, archivero, supervisor}.
El panel admin (`/diagnostico`) muestra estos 4 + el procesador principal.

---

## Cómo diagnosticar cada tipo de falla

### 🔴 1. "Recibí email 'Preflight oauth falló' pero el cliente no revocó"

**Síntoma:** email del sistema diciendo OAuth expirado, pero al chequear Google Account del cliente, los permisos siguen ahí.

**Causa raíz típica (95% de los casos):** rate limit del endpoint OAuth de Google. Cuando el cron dispara muchos clientes contra el MISMO `client_id` compartido (el Web Client de Operatto), Google rate-limita por client_id y devuelve `invalid_grant` transitorio a algunos.

**Fix aplicado 2026-05-15** (commit `6e93a1f`):
- `facturacion-cron.mts` ahora dispara con stagger 800ms (no `Promise.allSettled` simultáneo)
- `preflight.ts` reintenta 1 vez con backoff 1.5-2s al primer `invalid_grant`
- El marcado automático de `oauth_status='expired'` requiere PATRÓN (último run real no fue OK + invalid_grant ahora), no primer fallo

**Diagnóstico SQL:**
```sql
-- ¿Los 3+ clientes que recibieron email fallaron a la MISMA hora?
select
  cliente_id, started_at, status, error_message
from agent_runs
where agente_id = 'facturacion'
  and triggered_by = 'preflight'
  and started_at::date = current_date
  and status = 'fail'
order by started_at;
```

Si todos fallaron en la misma ventana <5s → rate limit transitorio, ignorar.
Si solo 1 cliente falla repetidamente en runs distintos → real, mandar re-onboarding.

---

### 🔴 2. "Cliente con muchos errores hoy"

**Síntoma:** panel `/operacion` muestra cliente con `errores_count > 30` en el último run.

**Diagnóstico:**
```sql
-- Ver el patrón de errores del último run
select
  payload->'error_pattern_breakdown' as patrones,
  payload->'sample_errors' as muestra
from agent_runs
where cliente_id = (select id from clientes where slug = 'CLIENTE_SLUG')
  and agente_id = 'facturacion'
  and started_at::date = current_date
order by started_at desc
limit 1;
```

**Interpretación según pattern dominante:**

| Pattern | Significado | Acción |
|---|---|---|
| `pdf-encrypted` | Extractos bancarios encriptados (Bancolombia, Itaú, Visa, Mastercard) | **Ignorar** — es ruido normal, no son facturas DIAN |
| `pdf-no-text` | PDFs escaneados solo imagen | Aceptable — son docs no procesables |
| `llm-no-invoice` | LLM determinó que doc no es factura | Aceptable — filtros funcionando |
| `xml-parse` | XML DIAN corrupto en el ZIP | Investigar si es 1 factura puntual o patrón |
| `api-quota` | Anthropic rate limit excedido | **Crítico** — subir a Tier 2 o reducir concurrencia |
| `api-overload` | Anthropic 529 / 503 | Transitorio — el daily cron retry resuelve |
| `sheets-quota` | Google Sheets API saturada (>300 read/min) | Stagger más entre clientes o entre meses |
| `drive-quota` | Drive API saturada | Idem |
| `oauth-invalid-grant` | Token Google inválido | Ver caso #1 arriba |
| `network-timeout` / `network-dns` / `network-reset` | Red inestable | Transitorio — retry del cron resuelve |
| `db-dedup` | Event duplicado (factura ya estaba en DB) | **Ignorar** — dedup funcionando |
| `other` | Sin patrón reconocido | Mirar `sample_errors` con detalle |

---

### 🔴 3. "Cliente con discrepancias 5-fuentes (Gmail≠Drive≠Sheet≠Events)"

**Síntoma:** panel `/operacion` → sección "Salud del archivo" muestra el cliente con meses en rojo.

**Diagnóstico:** abrir `/cliente/SLUG` → sección "Salud del archivo" muestra detalle por mes con discrepancias específicas (ej: `drive(17)≠sheet(18)`).

**Causas más comunes:**

| Discrepancia | Significado | Acción |
|---|---|---|
| `gmail > drive` | Gmail tiene más facturas que Drive | El procesador NO descargó ZIP/PDF correctamente. Revisar errors del run. |
| `drive > sheet` | Drive tiene PDFs que no están en Sheet (huérfanos) | El archivero debería auto-repararlos con regex o LLM. Si no, falló — re-disparar |
| `sheet > drive` | Sheet tiene filas sin link a PDF en Drive | El procesador no movió el PDF al folder del cliente. Bug puntual |
| `events ≠ sheet` | Events en DB ≠ filas en Sheet | El procesador procesó OK pero falló al escribir en Sheet (quota, race) |

**Re-dispatch desde panel admin:**
- Click `/cliente/SLUG` → sección Salud del archivo → "Re-validar ahora"
- Esto dispara el archivero solo para ese cliente (1-2 min, no global 5-10 min)

---

### 🔴 4. "Cliente no corrió hoy"

**Síntoma:** panel muestra "10 de 11 corrieron" — falta 1.

**Diagnóstico:**
```sql
select
  c.slug,
  c.activo as cliente_activo,
  ca.activo as agente_activo,
  cc.google_oauth_status,
  (select started_at from agent_runs ar
   where ar.cliente_id = c.id and ar.agente_id='facturacion'
   order by started_at desc limit 1) as ultimo_run
from clientes c
join client_agents ca on ca.cliente_id=c.id and ca.agente_id='facturacion'
left join client_credentials cc on cc.cliente_id=c.id and cc.agente_id='facturacion'
where ca.activo = true
order by ultimo_run desc nulls last;
```

Casos posibles:
- `cliente_activo=false` → desactivado intencionalmente
- `agente_activo=false` → facturación no habilitada para ese cliente
- `google_oauth_status != 'connected'` → OAuth roto, requiere re-onboarding
- `ultimo_run` muy viejo → algo bloqueó el cron específicamente para ese cliente

---

### 🔴 5. "Runs en estado 'running' por mucho tiempo (zombies)"

**Síntoma:** panel admin muestra runs marcados RUNNING aunque ya pasaron 30+ min.

**Diagnóstico:** el inspector debería cerrar zombies a las 8am Bogotá automáticamente. Si los ves persistir:
- El inspector no corrió (chequear inspector-cron logs en Netlify)
- O fallaron justo entre cron y cron del inspector

**Cleanup manual SQL:**
```sql
update agent_runs
set status='fail',
    finished_at=now(),
    error_message=coalesce(error_message,'Zombie cleanup manual')
where agente_id='facturacion'
  and status='running'
  and started_at < now() - interval '30 minutes'
returning id, cliente_id, started_at;
```

---

### 🔴 6. "Facturas no aparecen en el Sheet aunque están en Drive"

**Síntoma:** PDF visible en Drive folder pero no hay fila en Sheet.

**Causas:**
1. El procesador falló al escribir Sheet (quota exceeded típico)
2. El reparador no detectó el huérfano todavía (corre 8:15)
3. Bug del classifier (rare)

**Diagnóstico:** abrir `/cliente/SLUG` → sección "Salud del archivo" → si el mes muestra `pdfs_huerfanos > 0`, ver lista. El archivero las recupera al siguiente run (8:15 día siguiente) o al re-validar manualmente.

---

### 🔴 7. "Archivero no corrió hoy o falló"

**Síntoma:** panel muestra "Archivero · sin run" o run con status `fail`.

**Diagnóstico (priorizar en orden):**

1. **¿Netlify Function falló por timeout (>15min)?** → revisar Netlify logs del `archivero-background`
2. **¿Crasheó en runReparador o runLimpiador?** → el payload incluye `errores: [{etapa, error}]` separado por sub-agente
3. **¿Rollback manual?** → cambiar `archivero-cron.mts` schedule a `"0 0 31 2 *"` y revertir `reparador-cron.mts` y `limpiador-cron.mts` a sus schedules originales (`15 13 * * *` y `30 13 * * *`)

---

### 🔴 8. "Supervisor disparó muchos retriggers"

**Síntoma:** panel muestra `retriggers_disparados > 10` en el run del supervisor.

**Diagnóstico:** el supervisor tiene anti-loop por agente (3 retriggers max). Si llegó al cap, escala a intervención humana (campo `requiere_atencion_critica`).

```sql
select
  cliente_slug,
  detalles
from audit_log
where agente_id='supervisor'
  and accion='supervisor.escalar_intervencion_humana'
  and ts > current_date - interval '7 days'
order by ts desc;
```

Si ves clientes acá, hay algo crónico que ningún agente puede auto-resolver — investigar manualmente.

---

## Acciones manuales útiles

### Re-disparar UN cliente sin esperar al cron

```bash
SECRET="<FACTURACION_INTERNAL_SECRET>"
URL="https://equipodegentes-cron.netlify.app"

# Procesador facturas (Gmail → Drive → Sheet)
curl -X POST "$URL/.netlify/functions/facturacion-background" \
  -H "x-internal-secret: $SECRET" \
  -H "content-type: application/json" \
  -d '{"customerId":"SLUG_CLIENTE"}'

# Archivero (cross-check + auto-repair) — solo 1 cliente
curl -X POST "$URL/.netlify/functions/archivero-background" \
  -H "x-internal-secret: $SECRET" \
  -H "content-type: application/json" \
  -d '{"clienteSlug":"SLUG_CLIENTE"}'

# Inspector / Supervisor — corren para todos los clientes, no aceptan filtro
```

### Re-procesar un mes específico

```bash
curl -X POST "$URL/.netlify/functions/facturacion-background" \
  -H "x-internal-secret: $SECRET" \
  -H "content-type: application/json" \
  -d '{"customerId":"SLUG","monthFilter":3,"force":true,"silent":true,"skipSheetSetup":true,"skipPreflight":true}'
```

⚠️ NO disparar 3+ meses del mismo cliente concurrentemente — hit api-quota Anthropic (vimos en incidente 2026-05-14). Hacer secuencial con stagger 5-10 min entre meses.

### Revertir oauth_status manualmente

Si recibís un email "OAuth falló" pero verificás que el cliente no revocó:

```sql
update client_credentials
set google_oauth_status='connected'
where cliente_id=(select id from clientes where slug='SLUG')
  and agente_id='facturacion';
```

Esto asume que vos verificaste manualmente que el OAuth funciona. Si dudas, abrí panel `/cliente/SLUG` → "Validar ahora" en la sección de preflight.

---

## Métricas saludables esperadas

- **Cron 7am** (`facturacion`): 11 clientes despachados con stagger 800ms = ~9s total. Cada uno termina <5min normalmente.
- **Inspector 8am**: <30s total. Lee runs, suma costo, cierra zombies (típicamente 0 zombies en operación normal).
- **Archivero 8:15**: 2-5 min total (reparador rápido + limpiador con LLM para huérfanos residuales).
- **Supervisor 8:45**: <60s total. Solo retriggea si hay gap real (debería ser 0 retriggers en día sano).

**Si algún agente tarda >10 min** → algo está mal, investigar logs Netlify.

---

## Histórico de incidentes resueltos

| Fecha | Síntoma | Causa raíz | Fix |
|---|---|---|---|
| 2026-05-13 | Panel admin números errados | 8 bugs de queries (paginación, type-coercion, TZ) | commits `d2eecfe`, `13ffaf0` |
| 2026-05-14 | Catchup masivo 31% error rate Freshco | Anthropic Tier 1 rate limit con 3 runs concurrentes | Identificado en `INCIDENTE-2026-05-14-catchup-api-quota.md` |
| 2026-05-14 | Andres marcado `oauth=expired` con un solo invalid_grant | Fix preflight demasiado agresivo | Commit `155e004` — requiere patrón antes de marcar |
| 2026-05-15 | 3 emails OAuth simultáneos (andres, tomas92, mateoramirez) | Rate limit Google OAuth endpoint (multi-cliente parallel) | Commit `6e93a1f` — stagger 800ms + retry preflight |
