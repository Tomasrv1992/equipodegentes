// Borra etiquetas de Gmail por nombre (reset del cursor). Borrar una etiqueta
// la quita de todos los correos PERO no borra los correos.
import { google } from "googleapis";
async function main() {
  const year = Number(process.argv[2]) || new Date().getFullYear();
  const objetivo = [`Facturas/${year}`, `Descartado/${year}`, `Duplicado/${year}`];
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: "v1", auth: a });
  const list = await g.users.labels.list({ userId: "me" });
  const labels = list.data.labels ?? [];
  for (const name of objetivo) {
    const lbl = labels.find((l) => l.name === name);
    if (!lbl) { console.log(`(${name} no existe, skip)`); continue; }
    await g.users.labels.delete({ userId: "me", id: lbl.id! });
    console.log(`Borrada etiqueta: ${name}`);
  }
}
main().catch((e) => console.log("ERR", e?.message ?? e));
