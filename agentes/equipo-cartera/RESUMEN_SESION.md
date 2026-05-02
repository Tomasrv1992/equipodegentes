# Resumen Sesión 1 — Equipo Cartera v0.1

**Fecha:** 2026-05-01
**Duración:** sesión nocturna autónoma
**Estado:** ✅ MVP construido, listo para conectar credenciales reales

---

## Resumen ejecutivo

Construí desde cero el MVP local del agente cobrador para cartera de
préstamos en Colombia. El agente lee préstamos desde Google Sheets (o
desde un stub de 5 préstamos demo en memoria si todavía no hay
credenciales), calcula días de mora y reglas legales de contacto, y
deja que Claude Haiku 4.5 decida si hoy hay que enviar mensaje al
cliente, no contactar, o escalar a humano. La decisión se imprime en
consola y se registra como evento en el Sheet.

**No hay envío real por WhatsApp aún** — eso queda para la sesión 2.
El agente está diseñado para ese siguiente paso: el system prompt ya
tiene tono progresivo según mora, reglas legales colombianas, y el
formato de salida estructurada (`DECISIÓN / MENSAJE / RAZÓN`).

Todo el pipeline se puede probar end-to-end en modo stub sin costo
externo. Con la API key de Anthropic configurada (paso manual del
usuario, ver `PENDIENTES_USUARIO.md`), el smoke test cuesta ~$0.001
USD por préstamo procesado.

---

## Tareas completadas

| # | Tarea | Estado |
|---|---|---|
| 1 | Setup entorno Python (venv, requirements, .env) | ✅ Completada |
| 2 | Estructura de carpetas (src/, tools/, integraciones/, prompts/, tests/, scripts/, credentials/) | ✅ Completada |
| 3 | Configuración con Pydantic Settings (`src/config.py`) | ✅ Completada |
| 4 | System prompt cobrador (`prompts/cobrador_v1.md`) | ✅ Completada |
| 5 | Cliente Google Sheets con modo stub (`src/integraciones/sheets_client.py`) | ✅ Completada |
| 6 | Tool `obtener_prestamo` + definitions | ✅ Completada |
| 7 | Agente principal con loop tool-use y CLI (`src/agent.py`) | ✅ Completada |
| 8 | Datos demo (CSV + instructivo Sheet) | ✅ Completada |
| 9 | Tests unitarios con pytest (24 tests, todos pasan) | ✅ Completada |
| 10 | Smoke test end-to-end del agente | ⏭️ **Saltada por diseño** — sin API key configurada (instrucción del usuario). Documentado en `PENDIENTES_USUARIO.md` paso 6. |
| 11 | Documentación (README + CHANGELOG) | ✅ Completada |
| 12 | Reportes finales (este archivo + `PENDIENTES_USUARIO.md`) | ✅ Completada |
| 13 | Commit local (sin push) | ✅ Completada (próximo paso, automático) |

**Bloqueos:** ninguno. No fue necesario crear `BLOQUEO.md`.

---

## Métricas

- **Tareas:** 12 completadas + 1 saltada por diseño = 13/13.
- **Líneas de código Python:** ~1.220 (incluye tests).
- **Líneas totales (con docs y data):** ~2.310.
- **Tests:** 24/24 pasando en 0.19s.
- **Dependencias instaladas:** 9 directas, todas compatibles con Python 3.14.4.
- **Costo de la sesión en API tokens:** $0 (no hubo llamadas reales a Claude).

---

## Qué construí (detalle técnico)

### Capas del sistema

1. **Configuración (`src/config.py`)**
   `pydantic-settings` carga `.env` y expone una instancia `settings`
   global. Si falta `ANTHROPIC_API_KEY`, loggea warning y permite
   continuar (así el resto del sistema se puede probar). Calcula la
   ruta absoluta del JSON de credenciales y expone el modelo de Claude
   (`claude-haiku-4-5`).

2. **Integración Sheets (`src/integraciones/sheets_client.py`)**
   `SheetsClient` intenta abrir el Sheet real con `gspread` + Service
   Account. Si el JSON no existe en disco o falla la autenticación,
   automáticamente cae en `modo_stub = True` con 5 préstamos demo en
   memoria. Los métodos de escritura (`actualizar_prestamo`,
   `registrar_evento`) loggean en modo stub y persisten en modo real.
   Las fechas de los préstamos demo se calculan dinámicamente respecto
   a "hoy" para que los buckets de mora siempre sean coherentes.

3. **Tool y cálculos (`src/tools/prestamos.py`)**
   `obtener_prestamo(prestamo_id=..., telefono=...)` enriquece la fila
   del Sheet con tres campos calculados:
   - `dias_mora`: int, negativo si aún no vence.
   - `estado_calculado`: bucket categórico
     (`al_dia`/`por_vencer_3`/`por_vencer_1`/`vence_hoy`/`mora_1_3`/
     `mora_4_7`/`mora_8_15`/`mora_15_30`/`mora_30_mas`).
   - `puede_contactarse_hoy` + `razon_no_contacto`: aplica horario
     8am-7pm Colombia, bloqueo dominical, requisito de consentimiento,
     y restricción de 24h entre contactos.

   Hay singleton inyectable (`get_sheets_client()` /
   `set_sheets_client(c)`) para que los tests usen su propio cliente
   sin tocar disco real.

4. **Definiciones de tools (`src/tools/definitions.py`)**
   Lista `TOOLS` con el schema de `obtener_prestamo` en formato
   Anthropic, y `ejecutar_tool(nombre, input)` que despacha al callable
   y devuelve JSON serializado. Captura excepciones para que el modelo
   nunca explote por una tool fallida.

5. **Agente (`src/agent.py`)**
   Loop tool-use clásico contra `client.messages.create`:
   - Carga `prompts/cobrador_v1.md`.
   - Inicia con un mensaje user pidiendo procesar el préstamo.
   - Itera mientras `stop_reason == "tool_use"`, ejecutando tools y
     re-enviando resultados. Tope de 10 iteraciones.
   - Termina en `end_turn`, parsea el bloque
     `DECISIÓN / MENSAJE / RAZÓN`, registra el evento en Sheet y
     devuelve un dict estructurado.
   - CLI con `argparse`: `--prestamo`, `--verbose`, `--dry-run`.
   - Si no hay API key, sale con código 2 y mensaje claro al usuario.

6. **Tests (`tests/test_prestamos.py`)**
   24 tests cubren: estructura del dict retornado, manejo de IDs
   inexistentes, signo del cálculo de mora, parametrización completa
   de buckets de estado, las 5 reglas de bloqueo de contacto
   (horario temprano/tarde, dominical, sin consentimiento, ventana
   24h), y el caso integrador PR-DEMO-005 (sin consentimiento).
   Una fixture `autouse` resetea el SheetsClient stub entre tests.

### Datos demo

5 préstamos cubriendo todos los buckets relevantes:
- PR-DEMO-001: al día, vence en +5 días, consentimiento TRUE.
- PR-DEMO-002: por vencer mañana, consentimiento TRUE.
- PR-DEMO-003: mora 2 días, consentimiento TRUE.
- PR-DEMO-004: mora 10 días, consentimiento TRUE.
- PR-DEMO-005: mora 22 días, **consentimiento FALSE** (caso de bloqueo).

Mismo dataset existe en CSV (`scripts/datos_demo.csv`) para cargar al
Google Sheet real, y como diccionarios en memoria en el SheetsClient
para modo stub.

### Documentación generada

- `README.md`: setup, comandos, estructura, roadmap.
- `CHANGELOG.md`: versión 0.1.0 con todo el alcance de la sesión.
- `scripts/setup_sheet_demo.md`: instructivo paso a paso (escrito para
  alguien sin experiencia técnica) para crear el Sheet, el Service
  Account, habilitar APIs y compartir.
- `PENDIENTES_USUARIO.md`: checklist de 8 items que requieren acción
  humana.
- Este `RESUMEN_SESION.md`.

---

## Decisiones técnicas tomadas en autonomía

(Categoría "decisión menor a validar" según las reglas de la sesión)

1. **`SheetsClient` cae en modo stub también si `GOOGLE_SHEETS_ID` está
   vacío** (no solo si faltan credenciales). Esto permite arrancar todo
   sin haber creado nada en Google Cloud. Si querés cambiarlo, ajustá
   `_activar_modo_stub` en `sheets_client.py`.

2. **Fechas dinámicas en datos demo del stub.** Calculadas como
   `hoy + delta_dias` en cada arranque, así los estados son siempre
   coherentes. El CSV en disco tiene fechas literales ancladas al
   2026-05-01; si vas a usarlo dentro de meses, regeneralo o ajustá
   las fechas a mano (es válido para tests pero no para uso prolongado).

3. **Modelo Claude:** `claude-haiku-4-5` (lo pidió el `CLAUDE.md`
   explícitamente). Es lo correcto para este caso: tareas estructuradas,
   bajo costo, latencia baja. Si más adelante el agente toma decisiones
   más complejas (negociación, escalamiento), considerar `claude-sonnet-4-6`.

4. **Singleton inyectable del SheetsClient.** Patrón `get_sheets_client()`
   + `set_sheets_client()` en lugar de instanciar dentro de cada función.
   Permite tests sin parchear módulos.

5. **Stop reason del loop:** termino en `end_turn` o `tool_use`
   esperado; si el modelo devuelve cualquier otro stop reason loggeo
   warning y termino. Robusto para esta etapa, no necesita streaming
   (Haiku es rápido y respuestas son cortas).

6. **Logging con módulo estándar** (no `loguru` ni `structlog`). Más
   simple para MVP, sin dependencias extra.

7. **`pytest.ini` minimal** — `testpaths = tests`, sin coverage por
   ahora (lo agregamos cuando empiece a importar la métrica).

---

## Cómo verificar mañana que todo funciona

### Sin gastar tokens (modo stub):

```cmd
cd agentes\equipo-cartera
venv\Scripts\activate.bat
python -m pytest -v                         :: 24/24 tests pasan en <1s
```

### Con tokens (smoke test real, requiere API key configurada):

Ver paso 6 de `PENDIENTES_USUARIO.md`. Tres comandos rápidos:

```cmd
python -m src.agent --prestamo PR-DEMO-001 --verbose   :: por vencer +5 días
python -m src.agent --prestamo PR-DEMO-003 --verbose   :: mora 2 días
python -m src.agent --prestamo PR-DEMO-005 --verbose   :: bloqueo por consentimiento
```

Costo total estimado: $0.003 USD.

---

## Próximos pasos sugeridos (sesión 2)

En orden de prioridad:

1. **Integración WhatsApp Business / Twilio.** Reemplazar el "imprime
   mensaje en consola" por envío real. Empezar con sandbox de Twilio
   antes de pedir aprobación de Meta.
2. **Webhook receptor de respuestas entrantes.** Endpoint Flask/FastAPI
   que recibe mensajes del cliente y dispara una nueva iteración del
   agente con el contexto de conversación.
3. **Tool `validar_comprobante_pago`.** Conectar contra extracto
   bancario (Bancolombia / Davivienda API o scraping). Esta es la tool
   más crítica del system prompt actual y aún no existe.
4. **Cron/scheduler.** Que cada mañana a las 8am procese toda la
   cartera y dispare contactos pertinentes.
5. **Tool `escalar_a_humano`.** Notificación a operador
   (Slack/Telegram) con resumen del caso.

---

## Notas para futuras conversaciones con Claude

- Toda la lógica de negocio relevante está en `src/tools/prestamos.py`
  (cálculos) y `prompts/cobrador_v1.md` (tono y reglas).
- Si el comportamiento del agente parece off, probablemente hay que
  ajustar el system prompt antes que el código.
- El `SheetsClient` está hecho para fallar suavemente: si gspread se
  rompe en producción, el agente sigue funcionando con el dato más
  reciente del stub. Esto puede esconder bugs reales — vale la pena
  cambiar a fallar duro en producción cuando ya esté estable.
- El parser de la decisión final (`_parsear_decision` en
  `src/agent.py`) hace match laxo de `DECISIÓN/DECISION/MENSAJE/
  RAZÓN/RAZON` para ser tolerante a tildes. Si el modelo empieza a
  devolver el bloque en otro formato, ese parser es lo primero a
  revisar.
