/**
 * Validaciones estrictas para facturas y datos contables.
 *
 * Filosofía Tomás: "los agentes deben ser exigentes, no paisaje".
 * Si una factura no cumple estos checks, NO se procesa al Sheet y se
 * mueve a REVISAR_MANUAL/ para inspección humana.
 *
 * Estos helpers son compartidos por:
 *   - pipeline.ts (procesamiento de facturas DIAN y no-DIAN)
 *   - limpiador.ts (detección de filas basura en Sheets existentes)
 *   - backfill-events-from-sheet.mts (skip filas inválidas durante backfill)
 */

/**
 * Valida el formato del número de factura/documento.
 * Rechaza casos típicos de basura encontrados en producción:
 *   - "mayo de 2026"  (texto en vez de número)
 *   - "0,00E+00"      (notación científica de Excel)
 *   - "PRUEBA 002"    (filas de prueba)
 *   - ""              (vacío)
 *   - "12"            (solo 2 chars, sospechoso)
 *
 * Acepta:
 *   - "FELE308893"
 *   - "84292725"
 *   - "FEFL-3568"
 *   - "RTF-2026-001"
 */
export function esNumeroFacturaValido(numero: unknown): boolean {
  if (!numero) return false;
  const n = String(numero).trim();
  if (n.length < 3) return false;
  if (n.length > 50) return false; // > 50 chars es sospechoso
  // Notación científica de Excel
  if (/^[\d.,]+E[+\-]?\d+$/i.test(n)) return false;
  // Solo texto sin dígitos
  if (!/\d/.test(n)) return false;
  // Palabras que indican prueba/error
  if (/\b(PRUEBA|TEST|EJEMPLO|BORRAR|REVISAR|ERROR|TODO)\b/i.test(n)) return false;
  // Formato de fecha tipo "mayo de 2026"
  if (/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s/i.test(n)) {
    return false;
  }
  return true;
}

/**
 * Razón legible de por qué un número fue rechazado.
 * Útil para logging y reportes.
 */
export function razonNumeroInvalido(numero: unknown): string | null {
  if (!numero) return "vacío";
  const n = String(numero).trim();
  if (n.length < 3) return `muy corto (${n.length} chars)`;
  if (n.length > 50) return `demasiado largo (${n.length} chars)`;
  if (/^[\d.,]+E[+\-]?\d+$/i.test(n)) return `notación científica de Excel: "${n}"`;
  if (!/\d/.test(n)) return `solo texto sin dígitos: "${n}"`;
  if (/\b(PRUEBA|TEST|EJEMPLO|BORRAR|REVISAR|ERROR|TODO)\b/i.test(n)) {
    return `contiene palabra reservada de prueba: "${n}"`;
  }
  if (/^(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s/i.test(n)) {
    return `parece nombre de mes en lugar de número: "${n}"`;
  }
  return null;
}

/**
 * Valida fecha de factura.
 *   - Formato YYYY-MM-DD
 *   - No anterior a 2020 (Operatto arrancó después)
 *   - No futura (más allá de hoy)
 */
export function esFechaFacturaValida(fecha: unknown): boolean {
  if (!fecha) return false;
  const s = String(fecha).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const minYear = 2020;
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 1); // tolerancia de 1 día por zonas horarias
  if (d.getFullYear() < minYear) return false;
  if (d.getTime() > maxDate.getTime()) return false;
  return true;
}

export function razonFechaInvalida(fecha: unknown): string | null {
  if (!fecha) return "vacía";
  const s = String(fecha).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return `formato inválido: "${s}" (esperado YYYY-MM-DD)`;
  const d = new Date(s + "T00:00:00");
  if (isNaN(d.getTime())) return `fecha no parseable: "${s}"`;
  const minYear = 2020;
  const now = new Date();
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 1);
  if (d.getFullYear() < minYear) return `año anterior a ${minYear}: "${s}"`;
  if (d.getTime() > maxDate.getTime()) {
    const diasFuturo = Math.floor((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    return `fecha futura: "${s}" (${diasFuturo} días en el futuro)`;
  }
  return null;
}

/**
 * Valida NIT/cédula colombiana.
 * Solo verificamos el formato (cantidad de dígitos), no el dígito verificador
 * porque eso requeriría algoritmo DIAN y muchos proveedores pequeños no lo
 * incluyen correctamente.
 *
 * Acepta:
 *   - NIT empresa: 9-10 dígitos (900XXXXXX-X o 800XXXXXX-X)
 *   - Cédula: 6-10 dígitos
 *   - Vacío: TRUE (porque algunos casos legítimos no tienen NIT)
 */
export function esNitValido(nit: unknown): boolean {
  if (!nit) return true; // vacío es OK para cuentas de cobro persona natural sin cédula formal
  const limpio = String(nit).replace(/\D+/g, "");
  if (limpio.length === 0) return true;
  // Rango aceptado: 6-15 dígitos (cubre cédula extranjera, NIT, etc.)
  return limpio.length >= 6 && limpio.length <= 15;
}

/**
 * Valida monto de factura.
 * Detecta:
 *   - Negativos (no típico en compras, sospechoso)
 *   - Cero (puede ser legítimo: planillas SS, certificados — caller decide)
 *   - Excesivamente grande (> 100MM COP — pone bandera roja para revisión)
 */
export function montoSospechoso(total: unknown): {
  esSospechoso: boolean;
  razon: string | null;
} {
  if (total == null || total === "") return { esSospechoso: false, razon: null };
  const n = Number(total);
  if (isNaN(n)) return { esSospechoso: true, razon: `monto no numérico: "${total}"` };
  if (n < 0) return { esSospechoso: true, razon: `monto negativo: ${n}` };
  if (n > 100_000_000) return { esSospechoso: true, razon: `monto excesivo (>$100M): ${n}` };
  return { esSospechoso: false, razon: null };
}

/**
 * Valida una factura completa antes de procesarla.
 * Devuelve null si todo está OK, o un objeto con detalles del rechazo.
 */
export interface ValidacionResultado {
  esValida: boolean;
  motivos: string[];
}

export function validarFacturaCompleta(input: {
  numero: unknown;
  fecha: unknown;
  nit: unknown;
  total?: unknown;
  proveedor?: unknown;
}): ValidacionResultado {
  const motivos: string[] = [];

  const razonNum = razonNumeroInvalido(input.numero);
  if (razonNum) motivos.push(`numero: ${razonNum}`);

  const razonFecha = razonFechaInvalida(input.fecha);
  if (razonFecha) motivos.push(`fecha: ${razonFecha}`);

  if (!esNitValido(input.nit)) {
    motivos.push(`nit: formato inválido ("${input.nit}")`);
  }

  if (!input.proveedor || String(input.proveedor).trim().length < 2) {
    motivos.push(`proveedor: vacío o muy corto`);
  }

  if (input.total !== undefined) {
    const monto = montoSospechoso(input.total);
    if (monto.esSospechoso) motivos.push(`monto: ${monto.razon}`);
  }

  return {
    esValida: motivos.length === 0,
    motivos,
  };
}
