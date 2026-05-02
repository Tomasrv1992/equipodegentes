# Plan de Trabajo Nocturno — Equipo Cartera v0.1

## Ubicación
TODAS las rutas mencionadas en este plan son relativas a
`agentes/equipo-cartera/` dentro del repo `equipodegentes`.
Trabaja SOLO dentro de esta carpeta.

## Objetivo de esta sesión
Construir el MVP funcional del agente cobrador hasta el punto donde se
pueda ejecutar (desde dentro de agentes/equipo-cartera/):

```
python -m src.agent --prestamo PR-DEMO-001
```

Y el agente:
1. Lea el préstamo desde un Google Sheet de prueba (o del modo stub).
2. Calcule días de mora y estado.
3. Decida si hay que enviar mensaje hoy.
4. Si sí: redacte el mensaje exacto según tono progresivo del system prompt.
5. Si no: explique por qué (horario, ya contactado hoy, sin consentimiento).
6. Imprima decisión en consola y registre en pestaña `eventos` del Sheet.

NO se conecta Twilio en esta sesión. NO hay webhook. NO se reciben mensajes.

Si el Sheet real no está configurado (no hay credentials/service-account.json),
el SheetsClient debe operar en modo "stub" con datos hardcodeados, para que
el agente pueda probarse end-to-end sin intervención humana.

## Tareas a ejecutar EN ORDEN

### TAREA 1 — Setup del entorno Python
1. Crear venv local: `python -m venv venv`
2. Activar venv: `venv\Scripts\activate.bat`
3. Crear `requirements.txt` con:
   - anthropic>=0.40.0
   - python-dotenv>=1.0.0
   - pydantic>=2.7.0
   - pydantic-settings>=2.0.0
   - gspread>=6.0.0
   - google-auth>=2.30.0
   - python-dateutil>=2.9.0
   - pytz>=2024.1
   - pytest>=8.0.0
4. Crear `.gitignore` que ignore: venv/, .env, credentials/*.json,
   __pycache__/, *.pyc, .pytest_cache/, *.log, .DS_Store, *.egg-info/
5. Crear `.env.example` con todas las variables documentadas (ver lista abajo).
6. Crear `.env` con mismas keys, valores vacíos.
7. Instalar deps: `pip install -r requirements.txt`
8. Validar: `python -c "import anthropic, gspread, pydantic; print('ok')"`

CHECKPOINT 1: el comando de validación imprime `ok` sin errores.
Si alguna librería no es compatible con Python 3.14, intenta con la
versión más reciente disponible. Si tampoco funciona, documenta en
BLOQUEO.md.

### TAREA 2 — Estructura del proyecto
1. Crear carpetas `src/`, `src/tools/`, `src/integraciones/`,
   `prompts/`, `tests/`, `scripts/`, `credentials/`.
2. Crear `__init__.py` vacío en `src/`, `src/tools/`, `src/integraciones/`,
   `tests/`.
3. Crear `credentials/.gitkeep` vacío.

### TAREA 3 — Configuración con Pydantic
Crear `src/config.py`:
- Clase `Settings(BaseSettings)` con todos los campos del .env
- Validación de tipos
- Cargar desde .env automáticamente
- Exportar instancia global `settings`
- Si ANTHROPIC_API_KEY está vacío, permitir cargar pero loggear warning
  (no fallar, así el resto puede armarse aunque el usuario aún no
  tenga la key)

### TAREA 4 — System prompt del agente
Crear `prompts/cobrador_v1.md` con el contenido EXACTO de la sección
"SYSTEM PROMPT COMPLETO" al final de este PLAN_NOCHE.md.

### TAREA 5 — Cliente de Google Sheets con modo stub
Crear `src/integraciones/sheets_client.py`:

Clase `SheetsClient`:
- `__init__(self, sheet_id, credentials_path)`:
  - Si `credentials_path` existe en disco: inicializa gspread real.
  - Si NO existe: marca atributo `self.modo_stub = True` y carga
    datos hardcodeados (los 5 préstamos demo listados en TAREA 8).
- `leer_prestamo(prestamo_id: str) -> dict | None`
- `leer_prestamo_por_telefono(telefono: str) -> dict | None`
- `actualizar_prestamo(prestamo_id: str, campos: dict) -> bool`
- `registrar_evento(prestamo_id: str, tipo: str, contenido: str,
   canal: str = "sistema", resultado: str = "ok",
   costo_usd: float = 0.0) -> bool`

En modo stub, los métodos de escritura solo loggean lo que harían pero
no persisten. Esto permite probar el agente sin Sheet real.

Schemas de las pestañas (cuando hay Sheet real):
- Pestaña `prestamos` con columnas: id, cliente_nombre, cliente_telefono,
  cliente_cedula, monto_capital, tasa_mes, fecha_desembolso,
  fecha_vencimiento, frecuencia, saldo_pendiente, estado, ultimo_contacto,
  ultimo_canal, consentimiento_cobro
- Pestaña `eventos` con columnas: timestamp, prestamo_id, tipo, canal,
  contenido, resultado, costo_usd

### TAREA 6 — Tool: obtener_prestamo
Crear `src/tools/prestamos.py`:
- Función `obtener_prestamo(prestamo_id=None, telefono=None) -> dict`
- Usa SheetsClient internamente
- Calcula automáticamente:
  - `dias_mora`: int (días desde fecha_vencimiento, negativo si aún no vence)
  - `estado_calculado`: "al_dia" / "por_vencer_3" / "por_vencer_1" /
    "vence_hoy" / "mora_1_3" / "mora_4_7" / "mora_8_15" / "mora_15_30" /
    "mora_30_mas"
  - `puede_contactarse_hoy`: bool, considera:
    - Hora actual entre HORARIO_INICIO y HORARIO_FIN (Colombia tz)
    - Día de semana NO domingo
    - consentimiento_cobro == True
    - ultimo_contacto < ahora - 24h (si existe)
- Retorna dict completo con todos los campos del Sheet + los calculados

Crear `src/tools/definitions.py`:
- Lista `TOOLS` con schema de `obtener_prestamo` en formato Anthropic
- Función `ejecutar_tool(nombre: str, input_dict: dict) -> str` que
  despacha a la función correspondiente y retorna JSON string del resultado

### TAREA 7 — Agente principal
Crear `src/agent.py`:
- Función `cargar_system_prompt() -> str`: lee prompts/cobrador_v1.md
- Función `correr_agente(prestamo_id: str) -> dict`:
  1. Inicializa cliente Anthropic con settings.ANTHROPIC_API_KEY
  2. Carga system prompt
  3. Construye mensaje user inicial:
     "Procesa el préstamo {prestamo_id}. Decide si hay que enviar
      mensaje hoy. Si sí, redacta el mensaje exacto. Si no, explica
      por qué. Usa la tool obtener_prestamo para obtener los datos."
  4. Loop tool-use:
     - Llama API con messages + tools
     - Si stop_reason == "tool_use": ejecuta tool, agrega resultado a
       messages, repite
     - Si stop_reason == "end_turn": termina
     - Máximo 10 iteraciones para evitar bucles infinitos
  5. Registra evento en Sheet con la decisión
  6. Retorna dict con: mensaje_redactado, accion_tomada, costo_tokens
- CLI con argparse:
  - `python -m src.agent --prestamo PR-DEMO-001`
  - Flag `--dry-run` (default True por ahora)
  - Flag `--verbose` para imprimir cada paso del razonamiento
- Logging detallado con módulo logging
- Si ANTHROPIC_API_KEY no está configurada, salir con error claro
  pidiendo al usuario que la configure

### TAREA 8 — Datos demo y instrucciones para Sheet
Crear `scripts/setup_sheet_demo.md` con paso a paso DETALLADO para usuario
sin experiencia técnica. Estructura:

1. Crear Google Sheet llamado "Equipo Cartera DEMO".
2. Crear pestañas con esquema exacto.
3. Crear Service Account en Google Cloud Console (paso a paso con menús).
4. Habilitar Google Sheets API y Google Drive API.
5. Descargar JSON del Service Account → guardarlo como
   `credentials/service-account.json`.
6. Compartir el Sheet con el email del Service Account (Editor).
7. Copiar el ID del Sheet de la URL → pegar en .env como GOOGLE_SHEETS_ID.
8. Pegar contenido de scripts/datos_demo.csv en pestaña prestamos.

Crear `scripts/datos_demo.csv` con 5 préstamos demo, datos ficticios
realistas:
- PR-DEMO-001: al día, vence en +5 días, consentimiento TRUE
- PR-DEMO-002: por vencer, vence mañana, consentimiento TRUE
- PR-DEMO-003: mora 2 días, consentimiento TRUE
- PR-DEMO-004: mora 10 días, consentimiento TRUE
- PR-DEMO-005: mora 22 días, consentimiento FALSE (para probar bloqueo)

Todos con teléfonos ficticios formato +57300xxxxxxx, cédulas inventadas,
nombres comunes colombianos. Montos entre 500.000 y 2.000.000 COP.

Estos mismos 5 préstamos son los que el SheetsClient retorna en modo stub.

### TAREA 9 — Tests
Crear `tests/test_prestamos.py`:
- Test que `obtener_prestamo` (con stub) retorna estructura correcta
- Test que `dias_mora` calcula bien (mock de fecha)
- Test que `puede_contactarse_hoy` retorna False fuera de horario
- Test que retorna False si consentimiento_cobro == False
- Test que retorna False si ultimo_contacto < 24h

Crear `pytest.ini` con configuración básica.

### TAREA 10 — Smoke test del agente completo
Si ANTHROPIC_API_KEY está configurada en .env, ejecutar:
```
python -m src.agent --prestamo PR-DEMO-003 --verbose
```

y guardar la salida en `scripts/smoke_test_output.txt`. Esto demuestra
que el agente funciona end-to-end.

Si la API key NO está configurada, documentar en PENDIENTES_USUARIO.md
que este es el primer comando a correr cuando la peguen.

### TAREA 11 — Documentación
Actualizar `agentes/equipo-cartera/README.md` con:
- Descripción del proyecto y qué hace este MVP
- Pre-requisitos (Python, cuenta Anthropic, cuenta Google)
- Setup paso a paso para usuario nuevo
- Cómo correr el agente
- Estructura del proyecto
- Roadmap de próximas sesiones

Crear `CHANGELOG.md`:
```
# Changelog

## [0.1.0] — Sesión 1
### Added
- Estructura inicial del proyecto
- Cliente Google Sheets (modo real y stub)
- Tool obtener_prestamo con cálculos derivados
- Agent loop básico con tool-use
- System prompt v1 del agente cobrador
- Datos y scripts demo
- Tests unitarios básicos
```

### TAREA 12 — Reportes finales
Crear `RESUMEN_SESION.md` con:
- Lista de tareas completadas
- Lista de tareas bloqueadas (si las hubo) y por qué
- Líneas de código escritas (estimado)
- Próximos pasos sugeridos
- Cómo el usuario debe verificar el trabajo mañana

Crear `PENDIENTES_USUARIO.md` con CHECKLIST claro de acciones manuales:
1. Pegar ANTHROPIC_API_KEY en .env
2. Crear Google Sheet (link al instructivo)
3. Crear Service Account (link al instructivo)
4. Llenar GOOGLE_SHEETS_ID en .env
5. Comando para correr el primer test del agente

### TAREA 13 — Commit
- `git add agentes/equipo-cartera/`
- Verificar con `git status` que .env y credentials/*.json NO están en
  el commit
- `git commit -m "feat(equipo-cartera): MVP v0.1 - agente cobrador con lectura cartera"`
- NO hacer push, lo hace el usuario manualmente al revisar.

---

## Variables de entorno requeridas (para .env y .env.example)

```env
# === Anthropic ===
ANTHROPIC_API_KEY=sk-ant-xxxxx

# === Google Sheets ===
GOOGLE_SHEETS_ID=
GOOGLE_CREDENTIALS_PATH=./credentials/service-account.json

# === Operador ===
OPERADOR_NOMBRE=Equipo Cartera
OPERADOR_HORARIO_INICIO=8
OPERADOR_HORARIO_FIN=19
OPERADOR_TIMEZONE=America/Bogota

# === Modo ===
ENV=development
LOG_LEVEL=INFO
DRY_RUN=true
```

---

## SYSTEM PROMPT COMPLETO (para tarea 4)

Crear `prompts/cobrador_v1.md` con este contenido EXACTO:

```
Eres un asistente de gestión de cobranza para Equipo Cartera, un negocio
de préstamos personales en Colombia.

# Identidad
- Te presentas siempre como "asistente virtual de Equipo Cartera".
- NO finges ser humano. Si te preguntan, dices que eres un asistente automático.
- Hablas en español neutral colombiano, formal pero cercano. Usted, no tú.

# Tu trabajo
Gestionar la cobranza de préstamos vencidos y por vencer mediante WhatsApp:
1. Recordar pagos próximos a vencer (3 días, 1 día antes).
2. Cobrar pagos vencidos con tono progresivo según días de mora.
3. Recibir y validar comprobantes de pago.
4. Negociar acuerdos de pago dentro de límites pre-aprobados.
5. Escalar a humano cuando sea necesario.

# Tono según mora
- Por vencer: cordial, recordatorio amable.
- Mora 1-3 días: cordial, asume olvido.
- Mora 4-7 días: firme, pregunta motivo, ofrece opciones.
- Mora 8-15 días: serio, advierte sobre intereses moratorios contractuales.
- Mora 15+ días: escalas a humano. NO amenazas con reportes a centrales
  de riesgo, demandas, ni cobro jurídico por tu cuenta.

# Lo que SÍ puedes hacer sin escalar
- Aceptar pagos parciales del 30% o más del saldo vencido, con compromiso
  de saldo restante en máximo 7 días.
- Reagendar fecha de pago hasta 7 días en el futuro, una sola vez por préstamo.
- Aplicar pago confirmado y enviar comprobante de paz y salvo de la cuota.
- Compartir el estado del préstamo (saldo, próximo vencimiento) si el cliente
  pregunta.

# Lo que NUNCA haces (escalas inmediatamente)
- Condonar capital, intereses, o mora.
- Aceptar pagos parciales menores al 30%.
- Aplazar más de 7 días o más de una vez.
- Discutir términos del contrato original (tasas, recargos).
- Responder amenazas, insultos, o acusaciones de cobro indebido.
- Hablar con alguien que no sea el deudor titular.
- Contactar fuera del horario 8am-7pm hora Colombia, lunes a sábado.
  Domingos y festivos NO.

# Reglas legales (Colombia)
- Ley 1581 de 2012: solo contactas si hay consentimiento explícito
  (campo consentimiento_cobro = TRUE). Si está en FALSE, escalas a
  humano sin enviar nada.
- SIC: máximo 1 intento de contacto por día.
- Nunca contactes a referidos, familiares, jefes o terceros del deudor.
- Nunca uses lenguaje vejatorio, amenazante, o que sugiera consecuencias
  legales no estipuladas en el contrato.

# Validación de pagos (CRÍTICO)
Cuando el cliente diga "ya pagué" o envíe comprobante:
1. SIEMPRE pide la imagen del comprobante si solo lo dice por texto.
2. Llama a validar_comprobante_pago.
3. SOLO marca como pagado si la herramienta confirma match con el extracto.
4. Si no hay match, di: "Recibí su comprobante, lo estamos validando.
   En máximo 4 horas le confirmamos." Y escala a humano.
5. NUNCA confirmes un pago basado solo en la palabra del cliente o en
   un comprobante sin validar contra el banco.

# Formato de mensajes
- Máximo 3 líneas por mensaje.
- Sin emojis salvo ✅ para confirmar pagos.
- Saludo solo en el primer mensaje del día.
- Siempre cierra con: una acción concreta o una pregunta.

# Cuando uses tools
- Llama obtener_prestamo al inicio de cada conversación nueva.
- Llama escalar_a_humano y termina con: "Un asesor se contactará con
  usted en horario hábil. Que tenga buen día."

# Decisión final del turno
Después de obtener los datos del préstamo, decide UNA de estas opciones:
1. Enviar mensaje (redacta el mensaje exacto a enviar).
2. NO enviar mensaje hoy (explica brevemente por qué: fuera de horario,
   ya contactado, sin consentimiento, etc).
3. Escalar a humano (explica razón).

Tu respuesta final SIEMPRE debe terminar con un bloque así:

DECISIÓN: [enviar | no_enviar | escalar]
MENSAJE: [el mensaje exacto si decisión es "enviar", si no "N/A"]
RAZÓN: [explicación breve]
```

---

## Cosas que NO puedes hacer en esta sesión (requieren intervención humana mañana)

1. Crear el Google Sheet real.
2. Crear el Service Account de Google Cloud.
3. Llenar valores reales en `.env` (ANTHROPIC_API_KEY, GOOGLE_SHEETS_ID).
4. Descargar y colocar `credentials/service-account.json`.

NO te detengas por estos pendientes. Continúa con TODO lo demás usando
el modo "stub" del SheetsClient. Documenta los pendientes en
`PENDIENTES_USUARIO.md` con instrucciones paso a paso suficientes para
alguien sin experiencia técnica.