/**
 * Constantes fiscales para el cálculo de retenciones colombianas.
 *
 * Estos valores cambian anualmente (UVT) o por ciudad. Mantener actualizados.
 *
 * Fuente de referencia:
 *   - DIAN — Estatuto Tributario, libro III, capítulo I (Retenciones)
 *   - UVT 2026: Resolución DIAN
 *   - Tarifas ICA: Estatutos tributarios municipales
 */

// ============================================================================
// UVT — Unidad de Valor Tributario (cambia cada año)
// ============================================================================

export const UVT_POR_AÑO: Record<number, number> = {
  2024: 47065,  // referencia histórica
  2025: 49799,  // referencia histórica
  2026: 47065,  // TODO: actualizar cuando DIAN publique UVT 2026
};

/**
 * Devuelve el UVT del año dado, o el más reciente disponible si no se
 * encuentra. Conservador: si no hay match, usar el último año conocido.
 */
export function getUvt(año: number): number {
  if (UVT_POR_AÑO[año] !== undefined) return UVT_POR_AÑO[año];
  const años = Object.keys(UVT_POR_AÑO).map(Number).sort((a, b) => b - a);
  return UVT_POR_AÑO[años[0]] ?? 47065; // fallback al más reciente
}

// ============================================================================
// Tarifas Retención en la Fuente (RTF) por categoría
// ============================================================================
//
// % aplicado al subtotal de la factura cuando se aplica de oficio.
// Asume proveedor declarante (tarifa estándar). Si el cliente conoce que el
// proveedor no es declarante, puede agregar override por NIT con tarifa específica.
//
// Las categorías deben coincidir con las del archivo `categorizacion-reglas.json`.

export const TARIFAS_RTF_POR_CATEGORIA: Record<string, number> = {
  // Honorarios y comisiones — tarifa alta (servicios intelectuales/calificados)
  "Honorarios profesionales": 11,
  "Comisiones": 11,
  "Honorarios": 11,

  // Servicios técnicos — 6%
  "Servicios técnicos": 6,
  "Servicios": 6,
  "Software / SaaS": 6,
  "Asesoría / consultoría": 11,

  // Compras de bienes — 2.5%
  "Compras de bienes": 2.5,
  "Compras / suministros": 2.5,
  "Materiales": 2.5,
  "Equipos / herramientas": 2.5,

  // Arrendamientos
  "Arrendamiento inmueble": 3.5,
  "Arrendamiento muebles": 4,
  "Arriendos": 3.5,

  // Transporte
  "Transporte de carga": 1,
  "Transporte personas": 3.5,
  "Combustible y peajes": 0,    // exento RTF
  "Combustibles y peajes": 0,

  // Servicios públicos y salud (exentos)
  "Servicios públicos": 0,
  "Salud / medicamentos": 0,
  "Educación": 0,
  "Seguridad Social": 0,

  // Default conservador (asume compra de bienes — la tarifa más común)
  "Otros / sin clasificar": 2.5,
};

// ============================================================================
// Tarifas Retención de ICA por municipio
// ============================================================================
//
// % aplicado al subtotal cuando el cliente está obligado a retener ICA.
// Tarifas promedio por ciudad — la realidad es que cada actividad CIIU tiene
// su tarifa específica dentro del municipio. Usamos una promedio razonable.
//
// Fase 3 (futura): tarifa específica por CIIU.

export const TARIFAS_ICA_POR_MUNICIPIO: Record<string, number> = {
  "BOGOTA": 0.00414,       // 4.14 por mil (promedio actividades)
  "MEDELLIN": 0.007,       // 7 por mil
  "CALI": 0.011,           // 11 por mil
  "BARRANQUILLA": 0.0085,  // 8.5 por mil
  "BUCARAMANGA": 0.0066,
  "CARTAGENA": 0.0091,
  "PEREIRA": 0.007,
  "MANIZALES": 0.007,
  "OTRO": 0,               // requiere configuración manual del cliente
};

// ============================================================================
// Umbrales mínimos en UVT — facturas pequeñas no se retienen
// ============================================================================

export const UMBRALES_UVT = {
  /** RTF para servicios (honorarios, técnicos, generales, arrendamiento, transporte) */
  rtf_servicios: 4,      // ~ $188K en UVT 2026
  /** RTF para compras de bienes / materiales / equipos */
  rtf_compras: 27,       // ~ $1.27M en UVT 2026
  /** ICA mínimo */
  ica: 4,
  /** IVA mínimo */
  iva: 4,
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Decide si la categoría es un "servicio" (umbral RTF más bajo) o una
 * "compra de bienes" (umbral más alto). Determinante para aplicar el
 * umbral mínimo correcto.
 */
export function esCategoriaServicio(categoria?: string): boolean {
  if (!categoria) return false;
  const lower = categoria.toLowerCase();
  const palabrasServicio = [
    "honorario", "servicio", "comisi", "transporte",
    "arriend", "arrend", "consultor", "asesor",
  ];
  return palabrasServicio.some((p) => lower.includes(p));
}

/**
 * Lista de municipios soportados para el wizard de onboarding.
 * El cliente elige uno de estos al configurar sus retenciones.
 */
export const MUNICIPIOS_SOPORTADOS = [
  "BOGOTA",
  "MEDELLIN",
  "CALI",
  "BARRANQUILLA",
  "BUCARAMANGA",
  "CARTAGENA",
  "PEREIRA",
  "MANIZALES",
  "OTRO",
] as const;

export type MunicipioIca = typeof MUNICIPIOS_SOPORTADOS[number];
