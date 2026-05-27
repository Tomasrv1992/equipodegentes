/**
 * Pre-filtros heurísticos para evitar llamadas innecesarias al LLM.
 *
 * El costo de Anthropic es por consulta al LLM (no por factura procesada).
 * Antes de pagar una llamada, validamos que el documento PROBABLEMENTE sea
 * una factura. Si claramente no lo es (newsletter, notificación, etc),
 * skip silencioso sin tocar LLM.
 *
 * Estos filtros pueden tener falsos negativos (pierden alguna factura real),
 * pero el ahorro en consultas justifica el trade-off. Si Tomás detecta que
 * se está perdiendo algo, agregamos excepciones.
 */

// === A. Senders que claramente no mandan facturas ===========================

/**
 * Dominios y patterns de email que NO mandan facturas reales.
 * Si el sender matchea cualquiera de estos → skip sin LLM.
 *
 * Mantener actualizado conforme aparezcan falsos positivos en logs.
 */
const NON_INVOICE_SENDER_PATTERNS: RegExp[] = [
  // Confirmaciones de redes sociales / notificaciones personales (no billing)
  /@facebookmail\.com/i,
  /@linkedinmail\.com/i,
  /@instagram\.com/i,
  /@tiktok\.com/i,
  /@twitter\.com/i,
  /@x\.com/i,
  /notification[s]?@/i,

  // Marketing / promos
  /^(marketing|promo|promociones|newsletter|news|info)@/i,
  /@mailchimp\.com/i,
  /@sendgrid\.net/i,

  // Spam comercial colombiano típico (mayoría promos — pero overrides abajo
  // dejan pasar si el local-part dice billing/invoice/etc)
  /@mercadolibre\.com/i,
  /@rappi\.com/i,
  /@didi\./i,
  /@ifood\.com/i,

  // Calendly / Meet (invitaciones, no facturas)
  /@calendly\.com/i,
  /@meet\.google\.com/i,

  // Bancos: notificaciones (alertas de movimiento, no comprobantes)
  /alertas?@/i,
  /movimientos?@/i,
];

/**
 * Excepciones — si el sender contiene cualquiera de estos patterns en el
 * LOCAL-PART, NO es spam aunque matchee un dominio "negativo". Sirve para
 * casos como:
 *   - invoice+statements@linkedin.com (LinkedIn Ads, sí es factura)
 *   - billing@hubspot.com (HubSpot, sí es factura)
 *   - noreply+billing@apple.com (App Store, sí es factura)
 *   - payments@stripe.com (Stripe genérico, sí es factura)
 */
const INVOICE_OVERRIDE_PATTERNS: RegExp[] = [
  /(invoice|receipt|billing|statements?|payments?|subscription|finance|charges?)/i,
];

export function isLikelyNonInvoiceSender(sender: string): boolean {
  if (!sender) return false;
  // Override: si el local-part señala billing/invoice/etc, NO es spam
  const localPart = sender.split("@")[0] ?? "";
  if (INVOICE_OVERRIDE_PATTERNS.some((rx) => rx.test(localPart))) {
    return false;
  }
  return NON_INVOICE_SENDER_PATTERNS.some((rx) => rx.test(sender));
}

// === B. Subjects que claramente no son factura ==============================

/**
 * Palabras/frases en el subject que indican que NO es factura.
 * Match case-insensitive en el subject completo.
 */
const NON_INVOICE_SUBJECT_KEYWORDS = [
  // Newsletters y marketing
  "newsletter",
  "boletín",
  "boletin",
  "promo",
  "promoción",
  "promocion",
  "descuento",
  "oferta",
  "rebaja",
  "novedades",

  // Confirmaciones de eventos / inscripciones
  "confirmación de inscripción",
  "confirmacion de inscripcion",
  "te has registrado",
  "registration confirmed",
  "you're invited",
  "estás invitado",

  // Notificaciones de redes
  "te ha enviado un mensaje",
  "tienes una nueva notificación",
  "has tagged you",
  "te ha mencionado",

  // Marketing general
  "última oportunidad",
  "ultima oportunidad",
  "no te pierdas",
  "exclusivo para vos",
  "exclusivo para ti",

  // Reservas (típicamente no facturables — la factura llega aparte)
  "reservation confirmed",
  "tu reserva",
  "booking confirmation",

  // FIX 2026-05-27: bitácoras administrativas (caso Dentilandia)
  // Las contadoras de las clínicas mandan "bitácoras" como Word/PDF — NO son
  // facturas, son informes mensuales. Si el subject contiene "bitácora" en
  // cualquier forma, skipear sin procesar.
  "bitácora",
  "bitacora",
  "bitacora mes",
  "bitácora mes",
];

export function isLikelyNonInvoiceSubject(subject: string): boolean {
  if (!subject) return false;
  const lower = subject.toLowerCase();
  return NON_INVOICE_SUBJECT_KEYWORDS.some((kw) => lower.includes(kw));
}

// === C. El texto del documento debe contener indicadores de factura =========

/**
 * Para que valga la pena gastar una consulta LLM, el documento extraído debe
 * tener AL MENOS 1 indicador de que es factura/recibo. Sino, casi seguro no lo es.
 *
 * Indicadores: símbolos de moneda, palabras de facturación, números grandes
 * con decimales, etc.
 */
const INVOICE_INDICATORS: RegExp[] = [
  // Moneda
  /\$\s?\d/,           // $1234, $ 1,234
  /USD\s?\d/i,         // USD 100
  /COP\s?\d/i,
  /EUR\s?\d/i,
  /€\s?\d/,
  /CLP\s?\d/i,
  /MXN\s?\d/i,
  /\bcop\b/i,
  /\bpesos\b/i,
  /\bdólares\b/i,
  /\bdolares\b/i,

  // Palabras de facturación
  /\bfactura\b/i,
  /\binvoice\b/i,
  /\brecibo\b/i,
  /\bcobro\b/i,
  /\bcuenta\s+de\s+cobro\b/i,
  /\bpago\b/i,
  /\bpayment\b/i,
  /\btotal\s*[:=]/i,
  /\bsubtotal/i,
  /\bnit\b/i,
  /\bcedula\b/i,
  /\bcédula\b/i,
  /\btax\s+id/i,
  /\btax\s+invoice/i,
  /\bbill\s+to/i,
  /\bemitido\s+a/i,
  /\bemitida\s+a/i,
  /\bpara\s*:?\s*[a-záéíóúñ]/i,  // "Para: ..."

  // Estructura típica de factura
  /\bn[°º]\s*factura/i,
  /\bnúmero\s+de\s+factura/i,
  /\binvoice\s+number/i,
  /\bvalor\s+a\s+pagar/i,
  /\bamount\s+due/i,
];

export function hasInvoiceIndicators(text: string): boolean {
  if (!text || text.length < 30) return false;
  return INVOICE_INDICATORS.some((rx) => rx.test(text));
}

// === Pre-filter agregado: aplica los 3 en orden =============================

export interface PreFilterResult {
  /** True si el documento debería procesarse con LLM (pasa todos los filtros). */
  shouldCallLlm: boolean;
  /** Razón por la que se filtró (para log + skip reason). */
  skipReason?: string;
}

export function preFilterDocument(args: {
  sender: string;
  subject: string;
  text: string;
}): PreFilterResult {
  const { sender, subject, text } = args;

  // A) Sender obvio
  if (isLikelyNonInvoiceSender(sender)) {
    return {
      shouldCallLlm: false,
      skipReason: `pre-filter-sender (${sender.slice(0, 60)})`,
    };
  }

  // B) Subject obvio
  if (isLikelyNonInvoiceSubject(subject)) {
    return {
      shouldCallLlm: false,
      skipReason: `pre-filter-subject (${subject.slice(0, 60)})`,
    };
  }

  // C) Texto debe tener indicadores de factura
  if (!hasInvoiceIndicators(text)) {
    return {
      shouldCallLlm: false,
      skipReason: "pre-filter-sin-indicadores-factura",
    };
  }

  return { shouldCallLlm: true };
}

// === D. Costo estimado ======================================================

/**
 * Costo aproximado por llamada a Claude Haiku 4.5.
 * Pricing oficial Haiku 4.5: $1/1M input + $5/1M output.
 * Llamada típica ~2000 input + 200 output = $0.002 + $0.001 = $0.003 USD.
 * Mejor sobreestimar que subestimar para evitar sorpresas en factura mensual.
 */
export const LLM_COST_PER_CALL_USD = 0.003;

export function estimateLlmCost(calls: number): number {
  return Math.round(calls * LLM_COST_PER_CALL_USD * 10000) / 10000;
}
