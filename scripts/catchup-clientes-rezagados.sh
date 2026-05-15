#!/usr/bin/env bash
#
# Catchup masivo de meses incompletos.
#
# Caso: el diagnóstico de 2026-05-14 detectó que ciertos clientes tienen
# meses con menos facturas de lo esperado vs el patrón de proveedores
# consistentes (mismo proveedor todos los días hábiles).
#
#   Freshco:     ene/feb/mar incompletos (350/283/253 vs ~1300 esperado por mes)
#   Dentilandia: enero bajo (60 vs ~170 esperado)
#   Andres:      febrero bajo (10 vs ~40 esperado)
#
# Este script dispara los 5 re-procesos con stagger de 30s para no saturar
# Sheets API. Cada dispatch es async (background fn devuelve 202 inmediato)
# y procesa SOLO el mes especificado vía monthFilter.
#
# Flags por dispatch:
#   force=true            → re-lee emails con label "Procesado"
#   silent=true           → no manda email diario al cliente
#   notifyMonthComplete=true → cliente recibe "Listo {mes}: N facturas" al terminar
#   skipSheetSetup=true   → no rehacer las 12 pestañas (ya existen)
#   skipPreflight=true    → opcional, ya validamos OAuth manualmente
#
# Uso:
#   export FACTURACION_INTERNAL_SECRET="..."  # de Netlify env vars
#   export CRON_SITE_URL="https://<tu-site>.netlify.app"
#   bash scripts/catchup-clientes-rezagados.sh
#
# Tiempo total estimado: ~3 min de dispatches + ~10-15 min de procesamiento
# real en background. Mientras procesa, podés verlo en /operacion del panel
# admin (sección "En onboarding" o más tarde el histórico del cliente).

set -e

if [ -z "$FACTURACION_INTERNAL_SECRET" ]; then
  echo "❌ Falta env var: FACTURACION_INTERNAL_SECRET"
  echo "   Tomalo de Netlify dashboard → equipodegentes-cron → Site settings → Environment variables"
  exit 1
fi

if [ -z "$CRON_SITE_URL" ]; then
  echo "❌ Falta env var: CRON_SITE_URL"
  echo "   Ej: https://equipodegentes-cron.netlify.app (sin slash final)"
  exit 1
fi

ENDPOINT="$CRON_SITE_URL/.netlify/functions/facturacion-background"

dispatch() {
  local cliente="$1"
  local mes="$2"
  local mes_label="$3"
  echo "→ [$cliente] disparando mes=$mes ($mes_label)..."
  local response
  response=$(curl -sS -X POST "$ENDPOINT" \
    -H "x-internal-secret: $FACTURACION_INTERNAL_SECRET" \
    -H "x-trigger: catchup-manual-2026-05-14" \
    -H "content-type: application/json" \
    -d "{
      \"customerId\": \"$cliente\",
      \"monthFilter\": $mes,
      \"force\": true,
      \"silent\": true,
      \"notifyMonthComplete\": true,
      \"skipSheetSetup\": true,
      \"skipPreflight\": true
    }")
  echo "  response: $response"
  echo "  esperando 30s antes del próximo (evitar saturar Sheets API)..."
  sleep 30
}

echo "=== Catchup clientes rezagados — $(date) ==="
echo ""

# Freshco (3 meses: ene, feb, mar)
dispatch "freshco" 1 "enero"
dispatch "freshco" 2 "febrero"
dispatch "freshco" 3 "marzo"

# Dentilandia (enero)
dispatch "dentilandia" 1 "enero"

# Andres (febrero)
dispatch "andres" 2 "febrero"

echo ""
echo "✅ 5 dispatches enviados. Cada uno procesa en background (15min max)."
echo "   Validá en ~15-20 min con la query SQL en scripts/catchup-validar.sql"
