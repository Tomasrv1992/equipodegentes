/**
 * Health Score de cliente — 0 a 100.
 *
 * Calcula la "salud operacional" de un cliente combinando 4 dimensiones:
 *
 *   - Consistencia de fuentes (40 pts): Gmail/Drive/Sheet/Events cuadran
 *   - Errores recientes (30 pts):       sin runs 'fail' en últimos 7 días
 *   - Actividad reciente (20 pts):      al menos 1 factura en últimos 7 días
 *   - Procesamiento estable (10 pts):   no cayó > 50% vs mes anterior
 *
 * Total: 100 pts.
 *
 * Banding:
 *   - 90-100: 🟢 Excelente
 *   - 70-89:  🟡 Bueno con ojos abiertos
 *   - 50-69:  🟠 Atención
 *   - 0-49:   🔴 Crítico
 *
 * Filosofía: un score "honesto" — si hay algo mal, baja. Si todo cuadra, sube.
 * El operador (Tomás) no debe ver 100% si hay gaps reales.
 */

import type { ValidacionClienteCliente } from "../types";

export interface HealthScoreInput {
  /** Última validación 5 fuentes del reparador (si existe). */
  validacion: ValidacionClienteCliente | null;
  /** Cantidad de runs 'fail' en los últimos 7 días. */
  errores7d: number;
  /** Días desde la última factura procesada (999 si nunca). */
  diasSinFactura: number;
  /** Facturas procesadas en el mes actual. */
  factMes: number;
  /** Facturas procesadas en el mes anterior (completo). */
  factMesPrev: number;
  /** ¿El cliente tiene activación de facturacion activa? */
  tieneActivacion: boolean;
  /** ¿El cliente está marcado como activo en DB? */
  clienteActivo: boolean;
}

export interface HealthScoreResult {
  score: number; // 0-100
  banda: "excelente" | "bueno" | "atencion" | "critico" | "inactivo";
  color: "ok" | "warn" | "accent" | "fail" | "muted";
  detalle: {
    consistencia: { puntos: number; max: number; motivo: string };
    errores: { puntos: number; max: number; motivo: string };
    actividad: { puntos: number; max: number; motivo: string };
    tendencia: { puntos: number; max: number; motivo: string };
  };
  // Resumen humano de por qué el score
  razon: string;
}

export function calcularHealthScore(input: HealthScoreInput): HealthScoreResult {
  // Casos especiales: cliente inactivo o sin activación
  if (!input.clienteActivo) {
    return {
      score: 0,
      banda: "inactivo",
      color: "muted",
      detalle: emptyDetalle("cliente inactivo"),
      razon: "Cliente marcado como inactivo en la base de datos",
    };
  }
  if (!input.tieneActivacion) {
    return {
      score: 0,
      banda: "inactivo",
      color: "muted",
      detalle: emptyDetalle("sin activación facturacion"),
      razon: "Cliente sin agente Facturación activado (onboarding pendiente)",
    };
  }

  // 1. Consistencia de fuentes (40 pts)
  let consistencia = 0;
  let consistenciaMotivo = "Sin validación disponible";
  if (input.validacion) {
    const v = input.validacion;
    if (v.todo_cuadra) {
      consistencia = 40;
      consistenciaMotivo = "Las 4 fuentes cuadran exactamente";
    } else {
      // Penalizar según severidad del gap
      const maxCount = Math.max(v.gmail, v.drive, v.sheet, v.events, 1);
      const maxGap = Math.max(
        Math.abs(v.gmail - v.sheet),
        Math.abs(v.drive - v.sheet),
        Math.abs(v.events - v.sheet),
      );
      const gapPct = maxGap / maxCount;
      if (gapPct < 0.02) {
        consistencia = 35;
        consistenciaMotivo = `Gap < 2% (${maxGap} facturas)`;
      } else if (gapPct < 0.05) {
        consistencia = 25;
        consistenciaMotivo = `Gap 2-5% (${maxGap} facturas)`;
      } else if (gapPct < 0.1) {
        consistencia = 15;
        consistenciaMotivo = `Gap 5-10% (${maxGap} facturas)`;
      } else {
        consistencia = 5;
        consistenciaMotivo = `Gap > 10% (${maxGap} facturas) — crítico`;
      }
    }
  } else {
    consistencia = 20; // valor neutro si no hay validación
    consistenciaMotivo = "Sin validación reciente del reparador";
  }

  // 2. Errores 7d (30 pts) — penalización cuadrática
  let errores = 30;
  let erroresMotivo = "Sin errores en últimos 7 días";
  if (input.errores7d > 0) {
    // 1 error → 25 pts; 3 errores → 15 pts; 10+ → 0 pts
    errores = Math.max(0, 30 - input.errores7d * 5);
    erroresMotivo = `${input.errores7d} runs fail en últimos 7 días`;
  }

  // 3. Actividad reciente (20 pts)
  let actividad = 20;
  let actividadMotivo = "Procesando regularmente";
  if (input.diasSinFactura > 30) {
    actividad = 0;
    actividadMotivo = `Sin facturas en últimos ${input.diasSinFactura} días`;
  } else if (input.diasSinFactura > 14) {
    actividad = 5;
    actividadMotivo = `Sin facturas hace ${input.diasSinFactura} días`;
  } else if (input.diasSinFactura > 7) {
    actividad = 10;
    actividadMotivo = `Sin facturas hace ${input.diasSinFactura} días`;
  } else if (input.diasSinFactura > 3) {
    actividad = 15;
    actividadMotivo = `Última factura hace ${input.diasSinFactura} días`;
  }

  // 4. Tendencia (10 pts) — comparar mes actual prorrateado vs mes anterior
  let tendencia = 10;
  let tendenciaMotivo = "Volumen estable o creciente";
  if (input.factMesPrev > 0) {
    // Prorratear el mes actual: si vamos por el día N del mes, comparar N días iguales del mes anterior
    const diaDelMes = new Date().getDate();
    const diasEnMesAnterior = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      0,
    ).getDate();
    const ratioProrrateado = diaDelMes / diasEnMesAnterior;
    const esperadoActual = input.factMesPrev * ratioProrrateado;
    if (input.factMes < esperadoActual * 0.3) {
      tendencia = 0;
      tendenciaMotivo = `Caída > 70% vs ritmo del mes anterior`;
    } else if (input.factMes < esperadoActual * 0.5) {
      tendencia = 3;
      tendenciaMotivo = `Caída > 50% vs ritmo del mes anterior`;
    } else if (input.factMes < esperadoActual * 0.8) {
      tendencia = 7;
      tendenciaMotivo = `Caída leve vs mes anterior`;
    }
  } else {
    tendenciaMotivo = "Sin histórico para comparar";
  }

  const score = consistencia + errores + actividad + tendencia;

  // Determinar banda y color
  let banda: HealthScoreResult["banda"];
  let color: HealthScoreResult["color"];
  if (score >= 90) {
    banda = "excelente";
    color = "ok";
  } else if (score >= 70) {
    banda = "bueno";
    color = "ok";
  } else if (score >= 50) {
    banda = "atencion";
    color = "warn";
  } else {
    banda = "critico";
    color = "fail";
  }

  // Razón humana resumida
  const problemas: string[] = [];
  if (consistencia < 30) problemas.push(consistenciaMotivo);
  if (errores < 30) problemas.push(erroresMotivo);
  if (actividad < 15) problemas.push(actividadMotivo);
  if (tendencia < 7) problemas.push(tendenciaMotivo);
  const razon =
    problemas.length === 0
      ? "Operando con normalidad en todas las dimensiones"
      : problemas.join(" · ");

  return {
    score: Math.round(score),
    banda,
    color,
    detalle: {
      consistencia: { puntos: consistencia, max: 40, motivo: consistenciaMotivo },
      errores: { puntos: errores, max: 30, motivo: erroresMotivo },
      actividad: { puntos: actividad, max: 20, motivo: actividadMotivo },
      tendencia: { puntos: tendencia, max: 10, motivo: tendenciaMotivo },
    },
    razon,
  };
}

function emptyDetalle(motivo: string): HealthScoreResult["detalle"] {
  return {
    consistencia: { puntos: 0, max: 40, motivo },
    errores: { puntos: 0, max: 30, motivo },
    actividad: { puntos: 0, max: 20, motivo },
    tendencia: { puntos: 0, max: 10, motivo },
  };
}
