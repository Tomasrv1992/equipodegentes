# Changelog

Todas las versiones notables de este proyecto se documentan en este archivo.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [0.1.0] — 2026-05-01 — Sesión 1 (MVP local)

### Added
- Estructura inicial del proyecto bajo `agentes/equipo-cartera/`.
- Entorno virtual Python 3.14 con todas las dependencias congeladas en
  `requirements.txt`.
- Configuración global con `pydantic-settings` (`src/config.py`).
- Cliente de Google Sheets con fallback automático a modo stub cuando
  no hay credenciales (`src/integraciones/sheets_client.py`).
- Tool `obtener_prestamo` con cálculos derivados: días de mora, bucket
  de estado, evaluación de ventana de contacto legal
  (`src/tools/prestamos.py`).
- Definiciones de tools en formato Anthropic + dispatcher
  (`src/tools/definitions.py`).
- Agent loop con tool-use sobre Claude Haiku 4.5, CLI con argparse,
  registro de eventos en Sheet (`src/agent.py`).
- System prompt v1 del agente cobrador
  (`prompts/cobrador_v1.md`).
- Datos demo (`scripts/datos_demo.csv`) con 5 préstamos cubriendo todos
  los estados relevantes (al día, por vencer, mora corta/media/larga,
  sin consentimiento).
- Instructivo paso a paso para usuario no técnico de cómo crear el
  Google Sheet, el Service Account, y conectar todo
  (`scripts/setup_sheet_demo.md`).
- 24 tests unitarios con pytest cubriendo cálculo de mora, buckets de
  estado, reglas de contacto y la tool principal
  (`tests/test_prestamos.py`).
- Documentación: `README.md` con setup paso a paso, este `CHANGELOG.md`,
  `PENDIENTES_USUARIO.md` para acciones manuales y `RESUMEN_SESION.md`
  con el reporte de construcción.

### Reglas de negocio incorporadas
- Horario 8am–7pm hora Colombia, lunes a sábado.
- Solo contactar préstamos con `consentimiento_cobro = TRUE`
  (Ley 1581 de 2012).
- Máximo 1 mensaje saliente por préstamo por día.
- Sin reportes a centrales, demandas ni cobro jurídico autónomo.

### No incluido (planeado para sesiones siguientes)
- Envío real por WhatsApp (Twilio / Meta).
- Webhook receptor de mensajes entrantes.
- Validación de comprobantes contra extracto bancario.
- Cron de procesamiento masivo diario.
- Tool `escalar_a_humano` con notificación a operador.
- Tool `negociar_acuerdo` para parciales y reagendamientos.
