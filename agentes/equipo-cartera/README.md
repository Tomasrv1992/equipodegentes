# Equipo Cartera — Agente cobrador (MVP v0.1)

Agente autónomo que gestiona la cobranza de una cartera de préstamos
personales en Colombia. Lee préstamos desde un Google Sheet, calcula
días de mora y reglas de contacto, y deja que Claude decida si hoy hay
que enviar mensaje al cliente, no contactar, o escalar a humano.

> **MVP local**: el agente imprime su decisión en consola. **No envía
> mensajes reales por WhatsApp todavía** — la integración con Twilio /
> Meta queda para una próxima sesión.

---

## Estado actual

- ✅ Lectura de cartera (Google Sheets real o modo stub con datos demo)
- ✅ Cálculo de días de mora, estado y ventana de contacto legal
- ✅ Loop tool-use con Claude (`obtener_prestamo`)
- ✅ Decisión final estructurada (enviar / no_enviar / escalar)
- ✅ Registro de eventos en pestaña `eventos` del Sheet
- ⏳ Envío real por WhatsApp (próxima sesión)
- ⏳ Webhook de respuestas entrantes (próxima sesión)
- ⏳ Validación de comprobantes contra extracto bancario (próxima sesión)

---

## Pre-requisitos

1. **Python 3.14** instalado en el sistema (`python --version`).
2. **Cuenta Anthropic** con API key activa
   ([console.anthropic.com](https://console.anthropic.com/settings/keys)).
3. **Cuenta Google** (Gmail) para crear el Google Sheet y el Service
   Account.
4. **Windows** con Command Prompt (cmd) — los scripts de activación de
   venv asumen `cmd`, no PowerShell.

---

## Setup paso a paso

Todos los comandos asumen que estás parado en
`agentes/equipo-cartera/` dentro del repo `equipodegentes`.

### 1. Crear el entorno virtual e instalar dependencias

```cmd
python -m venv venv
venv\Scripts\activate.bat
pip install -r requirements.txt
```

Validá con:

```cmd
python -c "import anthropic, gspread, pydantic; print('ok')"
```

### 2. Configurar variables de entorno

Copiá `.env.example` a `.env` y llená al menos:

```env
ANTHROPIC_API_KEY=sk-ant-...     # de console.anthropic.com
GOOGLE_SHEETS_ID=                 # vacío al inicio: opera en modo stub
```

### 3. (Opcional pero recomendado) Conectar un Google Sheet real

Seguí las instrucciones detalladas en
[`scripts/setup_sheet_demo.md`](scripts/setup_sheet_demo.md). Cuando
termines, el agente leerá del Sheet real en lugar de los datos stub.

> **Mientras no tengas Sheet real**, el `SheetsClient` opera con 5
> préstamos demo hardcodeados. Esto sirve para probar todo el pipeline
> sin depender de credenciales externas.

---

## Cómo correr el agente

```cmd
venv\Scripts\activate.bat
python -m src.agent --prestamo PR-DEMO-001
```

Flags disponibles:
- `--prestamo PR-XXX-NNN` — ID del préstamo (obligatorio).
- `--verbose` (`-v`) — imprime cada paso del razonamiento del modelo.
- `--dry-run` — modo seguro (default; no envía nada externo).

Ejemplo completo:

```cmd
python -m src.agent --prestamo PR-DEMO-003 --verbose
```

Esperás ver al final algo como:

```
========== RESULTADO DEL AGENTE ==========
Préstamo:        PR-DEMO-003
Decisión:        enviar
Razón:           Mora de 2 días, en horario hábil, con consentimiento.
Mensaje:         Buen día, le habla el asistente virtual de Equipo Cartera.
                 Le recuerdo que su pago de $515.000 está vencido hace 2 días.
                 ¿Cuándo podríamos esperar el pago?
Iteraciones:     2  |  Tokens in/out:   1247/183
==========================================
```

---

## Probar la lógica sin gastar API tokens

```cmd
python -m pytest -v
```

24 tests cubren cálculo de mora, buckets de estado, ventana de contacto
legal, manejo de consentimiento, y la tool `obtener_prestamo`.

---

## Estructura del proyecto

```
agentes/equipo-cartera/
├── .env                       # Secretos (no se commitea)
├── .env.example               # Plantilla pública
├── .gitignore
├── README.md                  # Este archivo
├── CLAUDE.md                  # Contexto del proyecto para futuras sesiones
├── PLAN_NOCHE.md              # Plan original de construcción
├── PENDIENTES_USUARIO.md      # Acciones manuales que requieren intervención humana
├── RESUMEN_SESION.md          # Reporte de la sesión 1 de construcción
├── CHANGELOG.md
├── requirements.txt
├── pytest.ini
├── prompts/
│   └── cobrador_v1.md         # System prompt del agente
├── src/
│   ├── config.py              # Settings con Pydantic
│   ├── agent.py               # Loop tool-use + CLI
│   ├── tools/
│   │   ├── definitions.py     # Schemas de tools en formato Anthropic
│   │   └── prestamos.py       # Tool obtener_prestamo + cálculos derivados
│   └── integraciones/
│       └── sheets_client.py   # Cliente Google Sheets con fallback a stub
├── tests/
│   └── test_prestamos.py      # 24 tests unitarios
├── credentials/
│   └── service-account.json   # JSON del Service Account (vos lo creás, no se commitea)
└── scripts/
    ├── setup_sheet_demo.md    # Instructivo paso a paso para usuario no técnico
    └── datos_demo.csv         # 5 préstamos demo
```

---

## Reglas de negocio incorporadas

- **Horario:** 8am–7pm hora Colombia, lunes a sábado. Domingos no se contacta.
- **Consentimiento:** solo se contacta clientes con `consentimiento_cobro = TRUE`
  (Ley 1581 de 2012).
- **Frecuencia:** máximo 1 mensaje saliente por préstamo por día (SIC).
- **Tono progresivo:** cordial → firme → escalar. Mora > 30 días siempre escala.
- **Validación de pagos:** el agente NUNCA confirma un pago sin validación
  contra extracto bancario (la validación real se conectará en sesión 2).

---

## Roadmap

### Sesión 2 (próxima)
- Integración con WhatsApp Business / Twilio para envío real.
- Webhook receptor de mensajes entrantes.
- Tool `validar_comprobante_pago` contra extracto bancario.
- Tool `escalar_a_humano` con notificación a operador.
- Modo `cron` que procesa toda la cartera diariamente.

### Sesión 3
- Negociación de acuerdos de pago (reagendar, parciales).
- Dashboard simple de estado de cartera.
- Métricas: tasa de respuesta, recuperación, tiempo promedio de cierre.
- Multi-canal (SMS de respaldo si WhatsApp falla).

---

## Tecnologías

- **Python 3.14** + venv local
- **Claude Haiku 4.5** (`claude-haiku-4-5`) — modelo del agente
- **anthropic SDK** ≥ 0.40 — cliente oficial Anthropic
- **gspread** + `google-auth` — Google Sheets API
- **pydantic-settings** — validación y carga de configuración
- **pytest** — tests unitarios
- **pytz** + **python-dateutil** — manejo de zonas horarias y fechas

---

## Soporte

Esto es un MVP en construcción activa. Si algo falla:
1. Mirá los logs (`--verbose`) para encontrar dónde se rompe.
2. Revisá `BLOQUEO.md` (si existe) para issues conocidos.
3. Revisá `RESUMEN_SESION.md` y `PENDIENTES_USUARIO.md` para entender
   qué quedó por hacer.
