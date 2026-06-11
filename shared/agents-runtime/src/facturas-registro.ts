// shared/agents-runtime/src/facturas-registro.ts
//
// Guarda de deduplicación a nivel BASE DE DATOS. Es la PRIMERA línea de defensa
// contra duplicación de facturas: el UNIQUE (cliente_id, dedupe_key) de la tabla
// `facturas_registro` (migración 0018) hace FÍSICAMENTE IMPOSIBLE registrar dos
// veces la misma factura, sin importar qué código intente escribirla — incluido
// un deploy "zombie" como el que causó el incidente de Freshco en mayo 2026
// (1.088 facturas reales → 52.000+ filas en el Sheet).
//
// safeAppendToSheet (en el pipeline) se mantiene como SEGUNDA línea de defensa.
//
// DEGRADACIÓN ELEGANTE: esta función NUNCA lanza. Si la tabla todavía no existe
// (migración no aplicada) o hay cualquier otro problema con la BD, retorna un
// estado que deja seguir el flujo del pipeline tal como funcionaba antes.

import { getServerClient } from "./supabase-server";
import { calcularDedupeKey } from "./dedupe-key";

// Re-export para que los consumidores (pipeline, backfill, tests) importen la
// guarda y el cálculo de la clave desde un único módulo cohesivo.
export { calcularDedupeKey };
export type { DedupeKeyInput } from "./dedupe-key";

/**
 * Resultado de intentar reclamar una factura en `facturas_registro`:
 *   - 'insertada'      → la factura no estaba; quedó registrada. Seguir flujo normal.
 *   - 'duplicada'      → ya estaba registrada (constraint UNIQUE). Bloquear escritura.
 *   - 'tabla_no_existe'→ guarda BD inactiva (migración 0018 no aplicada, o error no
 *                        fatal de BD). Seguir flujo normal como antes (sin bloquear).
 */
export type ResultadoRegistro = "insertada" | "duplicada" | "tabla_no_existe";

export interface RegistrarFacturaInput {
  /** UUID del cliente (public.clientes.id). */
  clienteId: string;
  /** Clave de deduplicación ya calculada (ver calcularDedupeKey). */
  dedupeKey: string;
  /** CUFE de la factura DIAN (null para documentos no-DIAN). */
  cufe?: string | null;
  /** Gmail message id que originó el documento. */
  gmailMessageId: string;
  numeroDocumento?: string | null;
  fechaFactura?: string | null; // YYYY-MM-DD
  proveedorNit?: string | null;
  total?: number | null;
  /** 'pipeline' (procesamiento en vivo) | 'backfill' (carga histórica). */
  origen?: "pipeline" | "backfill";
}

/**
 * Intenta registrar una factura como procesada de forma atómica.
 *
 * Hace un INSERT con ON CONFLICT (cliente_id, dedupe_key) DO NOTHING
 * (vía upsert + ignoreDuplicates) y usa `.select()` para distinguir si la fila
 * fue insertada (devuelve la fila) o ya existía (devuelve 0 filas).
 *
 * NUNCA lanza: ante "tabla no existe" o cualquier otro error de BD, loguea un
 * warning y retorna 'tabla_no_existe' (guarda inactiva → el caller sigue normal).
 */
export async function registrarFacturaUnica(
  input: RegistrarFacturaInput,
): Promise<ResultadoRegistro> {
  try {
    const supa = getServerClient();
    const row = {
      cliente_id: input.clienteId,
      dedupe_key: input.dedupeKey,
      cufe: input.cufe ?? null,
      gmail_message_id: input.gmailMessageId,
      numero_documento: input.numeroDocumento ?? null,
      fecha_factura: input.fechaFactura ?? null,
      proveedor_nit: input.proveedorNit ?? null,
      total: input.total ?? null,
      origen: input.origen ?? "pipeline",
    };

    // upsert + ignoreDuplicates:true ⇒ "ON CONFLICT (cliente_id,dedupe_key) DO NOTHING".
    // .select() devuelve la fila SOLO si se insertó; si hubo conflicto, devuelve [].
    const { data, error } = await supa
      .from("facturas_registro")
      .upsert(row, { onConflict: "cliente_id,dedupe_key", ignoreDuplicates: true })
      .select("id");

    if (error) {
      if (esTablaNoExiste(error)) {
        console.warn(
          `[facturas_registro] tabla no existe — guarda BD inactiva. Aplicar migración 0018. (${error.message})`,
        );
        return "tabla_no_existe";
      }
      // Otro error de BD: degradación segura. NO bloqueamos el pipeline ni
      // duplicamos nada (safeAppendToSheet sigue siendo 2da línea de defensa).
      console.warn(
        `[facturas_registro] error no fatal — guarda BD inactiva este intento: ${error.message}`,
      );
      return "tabla_no_existe";
    }

    return data && data.length > 0 ? "insertada" : "duplicada";
  } catch (e: any) {
    // Falta de env vars en getServerClient, problemas de red, etc. Nunca rompemos.
    console.warn(
      `[facturas_registro] excepción no fatal — guarda BD inactiva: ${e?.message ?? e}`,
    );
    return "tabla_no_existe";
  }
}

/** Heurística para reconocer el error "la tabla no existe" (Postgres / PostgREST). */
function esTablaNoExiste(error: { code?: string; message?: string }): boolean {
  const code = error?.code ?? "";
  const msg = String(error?.message ?? "").toLowerCase();
  return (
    code === "42P01" || // Postgres: undefined_table
    code === "PGRST205" || // PostgREST: table not found in schema cache
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}
