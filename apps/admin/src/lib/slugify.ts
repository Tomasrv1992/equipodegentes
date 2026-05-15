/**
 * Convierte un nombre arbitrario en un slug URL-friendly.
 * Ej: "Sin Bata Co." → "sin-bata-co", "La Dentistería" → "la-dentisteria".
 *
 * Copia local de shared/agents-runtime/src/slugify.ts (apps/admin no importa de shared
 * porque sus builds son separados).
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar diacríticos combinantes (U+0300..U+036F)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
