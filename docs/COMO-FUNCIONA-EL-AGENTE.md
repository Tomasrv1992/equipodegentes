# Cómo funciona el Agente de Facturación

> Explicación del qué y el cómo del agente principal (`Equipo-facturacion`). Basado en el código real del repo. Pensado para entender el sistema sin tener que leer las 3.000 líneas del pipeline.

## En una frase

Automatiza el registro de facturas de gastos: lee los correos con facturas que llegan a la casilla del cliente, extrae los datos, archiva los PDFs en Google Drive ordenados por mes, y los registra en un Google Sheet — todos los días, sin intervención humana.

**Antes:** alguien abría cada email, bajaba el PDF, lo renombraba, lo subía a Drive y copiaba los datos a un Excel (~10 min/factura).
**Ahora:** el agente lo hace solo.

## Las piezas (dónde vive cada cosa)

| Pieza | Rol |
|---|---|
| **Gmail** del cliente | Entrada: bandeja con las facturas adjuntas |
| **Google Drive** del cliente | Archivo: carpetas `YYYY-MM/` con los PDFs |
| **Google Sheet** del cliente | Reporte: 12 pestañas mensuales + Dashboard |
| **Supabase (Postgres)** | Memoria del sistema: qué se procesó, runs, eventos, y la tabla `facturas_registro` (fuente de verdad anti-duplicados) |
| **Netlify Functions** | Donde corre el código (serverless) |
| **Claude (Haiku)** | Lee los documentos que NO son DIAN estructurado (cuentas de cobro Word, recibos PDF) |

## El flujo, paso a paso

1. **Reloj** — `facturacion-cron` corre todos los días a las **7am Bogotá**. Solo dispara el worker (no hace el trabajo).
2. **Orquestador** (`facturacion-background`) — por cada cliente: carga sus credenciales (OAuth Google + IDs de Drive/Sheet) desde Supabase, corre un **preflight** (chequea que OAuth/Drive/Sheet/Gmail respondan antes de empezar), y si todo está OK ejecuta el pipeline.
3. **Pipeline** (`run`) — arma una búsqueda en Gmail (facturas del período que todavía no tienen label de "procesado"), lista los emails y los procesa **de a uno, en orden cronológico**.
4. **Por cada email** (`processOne`) — mira los adjuntos y decide el tipo de documento:
   - **Factura DIAN** (ZIP con XML) → la lee con un **parser XML, CERO LLM** (es el formato electrónico oficial colombiano, 100% determinístico).
   - **Planilla de seguridad social** (PDF) → la archiva (el monto lo completa el cliente).
   - **Cuenta de cobro** (Word `.docx`) → la lee con **Claude** (no tiene formato estándar).
   - **Recibo PDF no-DIAN** (Stripe, AWS, servicios públicos) → la lee con **Claude**.
5. **Validar y filtrar** — descarta lo que no es factura (promos, extractos bancarios), las facturas que el **propio cliente emitió** (no son gastos), las de años anteriores y las inválidas. Cada descarte queda registrado con su motivo.
6. **Evitar duplicados — 3 capas de defensa:**
   - (a) Cache del Sheet en memoria durante el run.
   - (b) **Guarda en BD** (`facturas_registro`, constraint `UNIQUE (cliente_id, dedupe_key)`) → hace **físicamente imposible** registrar dos veces la misma factura, sin importar qué código intente escribirla. (Migración 0018, raíz: el incidente de mayo 2026 donde un deploy zombie infló 1.088 facturas a 52.000.)
   - (c) `safeAppendToSheet` → relee la columna del Sheet justo antes de escribir.
7. **Categorizar** — asigna categoría contable + cuenta PYG según el NIT del proveedor o palabras clave del concepto.
8. **Retenciones** — calcula ReteFuente / ReteIVA / ReteICA (del XML del proveedor, o por reglas del cliente si las tiene configuradas).
9. **Archivar + registrar** — sube el PDF a Drive (carpeta del mes, nombre `"{numero}. {Proveedor}.pdf"`) y escribe una fila en la pestaña del mes del Sheet (15 columnas: fecha, proveedor, NIT, # documento, montos, retenciones, total a pagar, categoría, link al PDF).
10. **Etiquetar en Gmail** — pone label `Facturas/AÑO` (procesada) o `Descartado/AÑO` (no era factura), para no reprocesar el mismo email.
11. **Registrar eventos en Supabase** — un evento por cada factura procesada (`factura_procesada`), por cada descarte (`email_descartado`) y por cada duplicado bloqueado por la guarda BD (`duplicado_bloqueado_bd`). Son la "caja negra" del sistema.

## Cómo se sabe que quedó bien (verificación)

- **Conciliación** (`conciliar-facturacion`): compara las **4 fuentes** (Gmail ↔ BD ↔ Sheet ↔ Drive) **por conjuntos de identificadores**, no por totales — así detecta si falta o sobra algo en cualquiera, aunque los totales coincidan por casualidad. Cero LLM, 100% determinística.
- **Panel admin**: lee los runs y eventos de Supabase para mostrar el estado de cada cliente de un vistazo.

## Multi-tenant

Cada cliente tiene sus credenciales y recursos (OAuth, carpeta Drive, Sheet) guardados en Supabase. **El mismo código corre para todos**; el cron simplemente itera por cliente. Agregar un cliente = onboarding (conecta su Google, elige carpeta y Sheet) — no requiere tocar código.

## Archivos clave (si querés bucear)

| Archivo | Qué es |
|---|---|
| `agentes/Equipo-facturacion/lib/pipeline.ts` | El corazón (~3.200 líneas): parseo, los 4 sub-pipelines, dedup, Drive, Sheet |
| `netlify/functions/facturacion-cron.mts` | El reloj (dispara diario) |
| `netlify/functions/facturacion-background.mts` | El orquestador (credenciales, preflight, run, eventos) |
| `agentes/Equipo-facturacion/lib/llm-extractor.ts` | Lectura con Claude de documentos no-DIAN |
| `shared/agents-runtime/src/facturas-registro.ts` | Guarda BD anti-duplicados (0018) |
| `shared/agents-runtime/src/agent-events.ts` | Emisión de eventos |
| `netlify/functions/conciliar-facturacion.mts` | Verificación de las 4 fuentes |

## Lo que NO hace (límites a tener claros)

- **No paga** facturas — solo las registra y archiva.
- En **planillas de seguridad social** el monto queda en 0 hasta que el cliente lo edita (todavía no se hace OCR del PDF).
- Para documentos **no-DIAN** depende del LLM, que puede equivocarse en casos borde (montos ambiguos, cuentas de cobro mal estructuradas). Por eso existe el harness de **evals** (`agentes/Equipo-facturacion/evals/`) para medir su precisión.
- Procesa **de a una factura por vez** (serial) para respetar el orden cronológico y no saturar las APIs de Google.
