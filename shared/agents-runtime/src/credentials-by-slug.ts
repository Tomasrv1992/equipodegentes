import { getServerClient } from "./supabase-server";
import { loadCredentials, type ClientCredentialsRow } from "./credentials";

/**
 * Helper de conveniencia: carga credenciales del cliente usando su slug
 * en vez del UUID. El cron itera sobre slugs (más legible).
 */
export async function loadCredentialsBySlug(
  clienteSlug: string,
  agenteId: string,
): Promise<ClientCredentialsRow | null> {
  const supa = getServerClient();
  const { data, error } = await supa
    .from("clientes")
    .select("id")
    .eq("slug", clienteSlug)
    .single();
  if (error || !data) return null;
  return loadCredentials((data as { id: string }).id, agenteId);
}

/**
 * Lista todos los clientes activos que tienen el agente activado.
 * Devuelve solo slug + nombre para el iterador del cron.
 */
export async function listActiveClientsForAgent(
  agenteId: string,
): Promise<Array<{ id: string; slug: string; nombre: string }>> {
  const supa = getServerClient();
  const { data, error } = await supa
    .from("client_agents")
    .select("cliente_id, clientes(id, slug, nombre, activo)")
    .eq("agente_id", agenteId)
    .eq("activo", true);

  if (error || !data) return [];

  // Supabase devuelve `clientes` como array (1 elemento) o objeto según el embed.
  // Manejamos ambos para robustez.
  const result: Array<{ id: string; slug: string; nombre: string }> = [];
  for (const rawRow of data as unknown as Array<Record<string, unknown>>) {
    const c = rawRow.clientes;
    const cliente = Array.isArray(c)
      ? (c[0] as { id: string; slug: string; nombre: string; activo: boolean } | undefined)
      : (c as { id: string; slug: string; nombre: string; activo: boolean } | null);
    if (cliente && cliente.activo) {
      result.push({
        id: cliente.id,
        slug: cliente.slug,
        nombre: cliente.nombre,
      });
    }
  }
  return result;
}
