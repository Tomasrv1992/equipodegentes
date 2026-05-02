# Equipo Cartera — Contexto del Proyecto

## Qué es
Agente autónomo de gestión de cartera de préstamos en Colombia. Automatiza
recordatorios de pago, cobranza por WhatsApp, conciliación de pagos contra
banco, y escalamiento a humano cuando es necesario.

Primera versión es MVP local: lee préstamos desde Google Sheets, decide
qué mensaje enviar, lo imprime en consola (NO lo envía aún a WhatsApp).

## Ubicación en el monorepo
Este proyecto vive en `agentes/equipo-cartera/` dentro del repo
`equipodegentes`. TODOS los archivos, comandos y rutas referidos en este
proyecto son RELATIVAS a `agentes/equipo-cartera/`. NO modifiques nada
fuera de esta subcarpeta.

Hay otros proyectos hermanos en `agentes/` (ej: `Equipo-facturacion`).
NO los toques.

## Stack obligatorio
- Python 3.14 instalado en el sistema
- Entorno virtual `venv/` LOCAL a la carpeta agentes/equipo-cartera/
- Claude API (anthropic SDK) — modelo `claude-haiku-4-5` por defecto
- Google Sheets API como cartera operativa (`gspread`)
- python-dotenv para variables de entorno
- pydantic-settings para validación de config

## Comando Python
Usa `python` para todos los comandos. Si `python` no funciona, usa `py`.

## Sistema operativo
Windows 10/11. Terminal: Command Prompt (cmd), NO PowerShell.
Comandos de activación de venv: `venv\Scripts\activate.bat`

## Estructura de archivos requerida
```
agentes/equipo-cartera/
├── .env                      # Secretos, ignorado por git
├── .env.example              # Plantilla, sí va al repo
├── .gitignore                # Específico de esta subcarpeta
├── README.md
├── CLAUDE.md                 # Este archivo
├── PLAN_NOCHE.md             # Plan de trabajo
├── PENDIENTES_USUARIO.md     # Acciones manuales (creas tú al final)
├── RESUMEN_SESION.md         # Reporte final (creas tú al final)
├── BLOQUEO.md                # Solo si hay bloqueos
├── requirements.txt
├── prompts/
│   └── cobrador_v1.md
├── src/
│   ├── __init__.py
│   ├── agent.py
│   ├── config.py
│   ├── tools/
│   │   ├── __init__.py
│   │   ├── definitions.py
│   │   └── prestamos.py
│   └── integraciones/
│       ├── __init__.py
│       └── sheets_client.py
├── tests/
│   └── test_prestamos.py
├── credentials/
│   └── .gitkeep
└── scripts/
    ├── setup_sheet_demo.md
    └── datos_demo.csv
```

## Reglas de código
- Type hints en todas las funciones públicas.
- Docstrings formato Google en español.
- Nombres de variables y funciones en español.
- Logging con módulo `logging`, nunca `print()` excepto en CLI final.
- try/except en cada llamada a API externa.
- No hardcodees rutas, todo desde config.

## Reglas de negocio críticas (NO violar)
- Horario envío: 8am-7pm hora Colombia, lunes a sábado. Domingos NO.
- Solo contactar préstamos con `consentimiento_cobro == TRUE`.
- Máximo 1 mensaje saliente por préstamo por día.
- Nunca confirmar pagos sin validación contra extracto bancario.
- Escalar a humano si: cliente agresivo, alega fraude, mora > 30 días,
  pide hablar con persona, o cualquier escenario fuera de protocolo.

## Lo que NO debes hacer JAMÁS
- Modificar archivos fuera de `agentes/equipo-cartera/`.
- Tocar otros agentes hermanos (`Equipo-facturacion`, etc).
- Crear cuentas o registrar servicios externos.
- Pagar nada.
- Enviar mensajes WhatsApp reales (no hay integración Twilio aún).
- Hacer `git push`.
- Borrar archivos `.env` o carpetas de credenciales.
- Usar sudo o instalar paquetes a nivel global del sistema.

## Estado actual
Sesión 1 de construcción. Empezando desde cero.
Sigue PLAN_NOCHE.md en orden estricto.

## Modelo de Claude para el código del agente
Cuando el código que escribas llame a la API de Anthropic, usa
`claude-haiku-4-5`.

## Manejo de errores y bloqueos
Si una tarea falla 2 veces, NO sigas insistiendo. Documenta el error
en BLOQUEO.md y continúa con la siguiente tarea independiente.

## Compatibilidad Python 3.14
Si encuentras incompatibilidades con Python 3.14 en alguna librería,
documenta en BLOQUEO.md, intenta versión alternativa de la librería,
y si no funciona, usa stub/mock para esa funcionalidad.