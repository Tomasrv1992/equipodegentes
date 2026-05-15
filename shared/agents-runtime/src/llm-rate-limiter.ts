/**
 * Token bucket rate limiter para llamadas a Anthropic API.
 *
 * Por qué existe: cuando el auto-fan-out de un cliente grande dispara 5-12
 * meses en paralelo, y cada mes procesa decenas de facturas con
 * `anthropic.messages.create`, podemos sobrepasar el rate limit de la cuenta
 * (50 RPM en tier 1, 1000 RPM en tier 2). El resultado: 429s en cascada
 * que el retry exponencial trata de absorber, pero termina abortando algunos
 * documentos.
 *
 * Solución: proactive rate limiting con token bucket. Antes de cada llamada,
 * `await acquireToken()` espera a que haya capacidad. Si está vacío, duerme
 * el tiempo exacto necesario para que se refille.
 *
 * Capacidad configurable via env var ANTHROPIC_RATE_LIMIT_PER_MIN (default 40).
 *
 * Limitación: este bucket es por-proceso. Cada invocación de Netlify Function
 * tiene su propio bucket, no hay sincronización entre invocaciones. Pero como
 * cada mes corre en su propio container, esto rate-limita CADA mes individual,
 * no la suma global de los 12 meses paralelos. Para sync global haría falta
 * Redis o equivalente — fuera de scope.
 */

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerSec: number;
}

let state: BucketState | null = null;

function getState(): BucketState {
  if (state) return state;
  const perMin = Number(process.env.ANTHROPIC_RATE_LIMIT_PER_MIN ?? "40");
  const cap = Math.max(1, Number.isFinite(perMin) ? perMin : 40);
  state = {
    tokens: cap,
    lastRefillMs: Date.now(),
    capacity: cap,
    refillPerSec: cap / 60,
  };
  return state;
}

function refill(s: BucketState): void {
  const now = Date.now();
  const elapsedSec = (now - s.lastRefillMs) / 1000;
  if (elapsedSec <= 0) return;
  const newTokens = s.tokens + elapsedSec * s.refillPerSec;
  s.tokens = Math.min(s.capacity, newTokens);
  s.lastRefillMs = now;
}

/**
 * Espera (si es necesario) hasta que haya capacidad para 1 llamada Anthropic
 * y consume el token. Llamar ANTES de `anthropic.messages.create()`.
 *
 * Implementación: revisa cuántos tokens hay disponibles, refilla según
 * tiempo transcurrido. Si tokens < 1, duerme el tiempo exacto necesario
 * para que la cuenta vuelva a 1. Después consume el token.
 */
export async function acquireLlmToken(): Promise<void> {
  const s = getState();
  refill(s);
  if (s.tokens >= 1) {
    s.tokens -= 1;
    return;
  }
  // No hay tokens — calcular cuánto esperar para tener exactamente 1
  const deficit = 1 - s.tokens;
  const waitMs = Math.ceil((deficit / s.refillPerSec) * 1000);
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Tras el sleep deberíamos tener al menos 1 — pero refrescamos por las
  // dudas (clock skew, sleep mayor que pedido).
  refill(s);
  s.tokens = Math.max(0, s.tokens - 1);
}

/**
 * Stats del bucket (para debug / logging). No es para uso productivo.
 */
export function llmRateLimiterStats(): {
  tokens: number;
  capacity: number;
  perMin: number;
} {
  const s = getState();
  refill(s);
  return {
    tokens: Math.round(s.tokens * 100) / 100,
    capacity: s.capacity,
    perMin: s.capacity,
  };
}

/**
 * Reset del bucket — solo usar en tests.
 */
export function _resetLlmRateLimiter(): void {
  state = null;
}
