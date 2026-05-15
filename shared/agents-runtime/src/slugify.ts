/**
 * Convierte un nombre arbitrario en un slug URL-friendly.
 * Ej: "Sin Bata Co." → "sin-bata-co", "La Dentistería" → "la-dentisteria".
 */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quitar diacríticos combinantes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")     // no-alfanum → guión
    .replace(/^-+|-+$/g, "");        // recortar guiones extremos
}
