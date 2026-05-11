/**
 * Engine de retenciones colombianas.
 *
 * Decide cuánto retener (RTF, IVA, ICA) para cada factura aplicando:
 *   1. Override por NIT del proveedor (si el cliente declaró exento) → gana
 *   2. Valor del XML DIAN (el proveedor lo calculó con su régimen) → usar tal cual
 *   3. Cálculo de oficio si el cliente es agente retenedor y el XML está vacío
 *
 * Produce un `RetencionResult` con valores + audit trail (`source`) que indica
 * de dónde salió cada valor. El audit trail se guarda en `agent_events.payload`.
 */

import type { InvoiceData } from "./pipeline";
import {
  TARIFAS_RTF_POR_CATEGORIA,
  TARIFAS_ICA_POR_MUNICIPIO,
  UMBRALES_UVT,
  getUvt,
  esCategoriaServicio,
} from "./retenciones-constants";

// ============================================================================
// Tipos públicos
// ============================================================================

export type TipoPersona =
  | "juridica"               // empresa con NIT — default agente retenedor
  | "natural_declarante"     // persona natural declarante de renta — tarifa RTF estándar
  | "natural_no_declarante"; // persona natural no declarante — RTF mayor (~10% vs 11%)

export interface RetentionRules {
  version: number;
  /**
   * Tipo del cliente que paga. Afecta:
   *   - Si es agente retenedor por defecto (jurídicas sí, naturales depende)
   *   - Tarifa RTF de oficio (naturales no declarantes tienen tarifa diferente)
   */
  tipo_persona?: TipoPersona;
  es_agente_retenedor: {
    reteFuente: boolean;
    reteIva: boolean;
    reteIca: boolean;
  };
  aplicar_de_oficio: {
    rtf_si_xml_vacio: boolean;
    ica_si_xml_vacio: boolean;
  };
  overrides_por_nit?: Record<string, NitOverride>;
  notas?: string;
}

export interface NitOverride {
  exento_rtf?: boolean;
  exento_iva?: boolean;
  exento_ica?: boolean;
  nota?: string;
}

export type RetencionSource = "xml" | "oficio" | "override_nit" | "none";

export interface RetencionResult {
  reteFuente: number;
  reteIva: number;
  reteIca: number;
  totalRetenciones: number;
  source: {
    rtf: RetencionSource;
    iva: RetencionSource;
    ica: RetencionSource;
  };
}

// ============================================================================
// API principal
// ============================================================================

/**
 * Aplica las reglas de retención del cliente a una factura.
 * Devuelve los 3 valores + audit trail de cada uno.
 */
export function aplicarReglasRetencion(
  factura: InvoiceData,
  reglas: RetentionRules,
  municipioIca: string | null,
  año: number = new Date().getFullYear(),
): RetencionResult {
  const override = reglas.overrides_por_nit?.[factura.nit];

  // ── RTF ────────────────────────────────────────────────────────────────
  let reteFuente = 0;
  let rtfSource: RetencionSource = "none";
  if (override?.exento_rtf) {
    reteFuente = 0;
    rtfSource = "override_nit";
  } else if ((factura.reteFuente ?? 0) > 0) {
    reteFuente = factura.reteFuente ?? 0;
    rtfSource = "xml";
  } else if (
    reglas.es_agente_retenedor.reteFuente &&
    reglas.aplicar_de_oficio.rtf_si_xml_vacio
  ) {
    reteFuente = calcularRtfDeOficio(factura, año);
    rtfSource = reteFuente > 0 ? "oficio" : "none";
  }

  // ── IVA ────────────────────────────────────────────────────────────────
  let reteIva = 0;
  let ivaSource: RetencionSource = "none";
  if (override?.exento_iva) {
    reteIva = 0;
    ivaSource = "override_nit";
  } else if ((factura.reteIva ?? 0) > 0) {
    reteIva = factura.reteIva ?? 0;
    ivaSource = "xml";
  }
  // Nota: ReteIVA NO se aplica de oficio. Si el proveedor no facturó retenido
  // y el cliente es agente retenedor, lo configura manualmente como override.

  // ── ICA ────────────────────────────────────────────────────────────────
  let reteIca = 0;
  let icaSource: RetencionSource = "none";
  if (override?.exento_ica) {
    reteIca = 0;
    icaSource = "override_nit";
  } else if ((factura.reteIca ?? 0) > 0) {
    reteIca = factura.reteIca ?? 0;
    icaSource = "xml";
  } else if (
    reglas.es_agente_retenedor.reteIca &&
    reglas.aplicar_de_oficio.ica_si_xml_vacio &&
    municipioIca
  ) {
    reteIca = calcularIcaDeOficio(factura, municipioIca, año);
    icaSource = reteIca > 0 ? "oficio" : "none";
  }

  return {
    reteFuente,
    reteIva,
    reteIca,
    totalRetenciones: reteFuente + reteIva + reteIca,
    source: { rtf: rtfSource, iva: ivaSource, ica: icaSource },
  };
}

// ============================================================================
// Cálculos internos
// ============================================================================

/**
 * Calcula RTF de oficio según categoría del servicio/producto + umbral UVT.
 * Devuelve 0 si:
 *   - El subtotal no supera el umbral mínimo (4 UVT servicios / 27 UVT compras)
 *   - La tarifa de la categoría es 0 (exentos: combustible, salud, etc)
 *   - No se puede determinar la categoría
 */
export function calcularRtfDeOficio(factura: InvoiceData, año: number): number {
  const uvt = getUvt(año);
  const categoria = factura.categoria ?? "Otros / sin clasificar";
  const tarifa = TARIFAS_RTF_POR_CATEGORIA[categoria] ?? 2.5;
  if (tarifa === 0) return 0;

  const esServicio = esCategoriaServicio(categoria);
  const umbral = esServicio
    ? UMBRALES_UVT.rtf_servicios * uvt
    : UMBRALES_UVT.rtf_compras * uvt;

  if (factura.subtotal < umbral) return 0;
  return Math.round(factura.subtotal * (tarifa / 100));
}

/**
 * Calcula ReteICA de oficio según tarifa del municipio + umbral UVT.
 * Devuelve 0 si:
 *   - El subtotal no supera el umbral (4 UVT)
 *   - El municipio no tiene tarifa configurada
 */
export function calcularIcaDeOficio(
  factura: InvoiceData,
  municipio: string,
  año: number,
): number {
  const uvt = getUvt(año);
  const umbral = UMBRALES_UVT.ica * uvt;
  if (factura.subtotal < umbral) return 0;

  const tarifa = TARIFAS_ICA_POR_MUNICIPIO[municipio] ?? 0;
  if (tarifa === 0) return 0;

  return Math.round(factura.subtotal * tarifa);
}

// ============================================================================
// Default rules (para clientes sin configurar)
// ============================================================================

export const DEFAULT_RETENTION_RULES: RetentionRules = {
  version: 1,
  es_agente_retenedor: {
    reteFuente: true,
    reteIva: false,
    reteIca: false,
  },
  aplicar_de_oficio: {
    rtf_si_xml_vacio: true,
    ica_si_xml_vacio: false,
  },
  overrides_por_nit: {},
  notas: "Configuración default — revisar en el wizard de onboarding",
};
