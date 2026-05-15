# scripts/catchup-clientes-rezagados.ps1
#
# Versión PowerShell del catchup masivo (Windows nativo, sin bash).
#
# Uso:
#   $env:FACTURACION_INTERNAL_SECRET = "..."
#   $env:CRON_SITE_URL = "https://<tu-site>.netlify.app"
#   ./scripts/catchup-clientes-rezagados.ps1
#
# Caso: el diagnóstico del 2026-05-14 detectó meses incompletos en:
#   Freshco:     ene/feb/mar (350/283/253 vs ~1300 esperado por mes)
#   Dentilandia: enero (60 vs ~170 esperado)
#   Andres:      febrero (10 vs ~40 esperado)
#
# El script dispara 5 re-procesos con stagger 30s para no saturar Sheets API.
# Cada dispatch es async — script termina en ~3 min, procesamiento real en
# background de Netlify hasta 15 min por mes.

$ErrorActionPreference = "Stop"

if (-not $env:FACTURACION_INTERNAL_SECRET) {
  Write-Host "❌ Falta env var: FACTURACION_INTERNAL_SECRET" -ForegroundColor Red
  Write-Host "   Tomalo de Netlify dashboard → equipodegentes-cron → Site settings → Environment variables"
  exit 1
}

if (-not $env:CRON_SITE_URL) {
  Write-Host "❌ Falta env var: CRON_SITE_URL" -ForegroundColor Red
  Write-Host "   Ej: https://equipodegentes-cron.netlify.app (sin slash final)"
  exit 1
}

$endpoint = "$env:CRON_SITE_URL/.netlify/functions/facturacion-background"

function Dispatch($cliente, $mes, $mesLabel) {
  Write-Host "→ [$cliente] disparando mes=$mes ($mesLabel)..." -ForegroundColor Cyan

  $body = @{
    customerId          = $cliente
    monthFilter         = $mes
    force               = $true
    silent              = $true
    notifyMonthComplete = $true
    skipSheetSetup      = $true
    skipPreflight       = $true
  } | ConvertTo-Json -Compress

  try {
    $response = Invoke-RestMethod -Uri $endpoint -Method Post `
      -Headers @{
        "x-internal-secret" = $env:FACTURACION_INTERNAL_SECRET
        "x-trigger"         = "catchup-manual-2026-05-14"
        "content-type"      = "application/json"
      } `
      -Body $body `
      -TimeoutSec 60
    Write-Host "  response: $($response | ConvertTo-Json -Compress)" -ForegroundColor Green
  } catch {
    Write-Host "  ⚠️ error: $($_.Exception.Message)" -ForegroundColor Yellow
  }

  Write-Host "  esperando 30s antes del próximo (evitar saturar Sheets API)..."
  Start-Sleep -Seconds 30
}

Write-Host ""
Write-Host "=== Catchup clientes rezagados — $(Get-Date) ===" -ForegroundColor White
Write-Host ""

# Freshco — 3 meses
Dispatch "freshco" 1 "enero"
Dispatch "freshco" 2 "febrero"
Dispatch "freshco" 3 "marzo"

# Dentilandia — enero
Dispatch "dentilandia" 1 "enero"

# Andres — febrero
Dispatch "andres" 2 "febrero"

Write-Host ""
Write-Host "✅ 5 dispatches enviados. Cada uno procesa en background (15min max)." -ForegroundColor Green
Write-Host "   Validá en ~15-20 min con scripts/catchup-validar.sql" -ForegroundColor White
