// Diagnóstico: cuentas de cobro que quedaron en Descartado/2026.
import { google } from "googleapis";
async function main() {
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const g = google.gmail({ version: "v1", auth: a });
  // Descartado + subject cuenta de cobro / CC
  const q = `label:Descartado/2026 (subject:("cuenta de cobro") OR subject:("nota de cobro") OR subject:(cobro))`;
  const ids: string[] = [];
  let pt: any;
  do { const r: any = await g.users.messages.list({ userId: "me", q, maxResults: 100, pageToken: pt }); ids.push(...(r.data.messages ?? []).map((m: any) => m.id)); pt = r.data.nextPageToken; } while (pt);
  console.log(`Descartado con asunto de cobro: ${ids.length}\n`);
  const tipos: Record<string, number> = {};
  for (const id of ids.slice(0, 25)) {
    const m = await g.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] });
    const h = m.data.payload?.headers ?? [];
    const get = (n: string) => h.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    // tipos de adjunto
    const full = await g.users.messages.get({ userId: "me", id, format: "full" });
    const names: string[] = [];
    const walk = (p: any) => { if (!p) return; if (p.filename) names.push(p.filename); (p.parts || []).forEach(walk); };
    walk(full.data.payload);
    const exts = names.filter(Boolean).map((n) => (n.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase()).join(",");
    exts.split(",").forEach((e) => { if (e) tipos[e] = (tipos[e] || 0) + 1; });
    console.log(`- de: ${get("From").slice(0, 45)} | ${get("Subject").slice(0, 50)} | adj: ${names.join(", ").slice(0, 60)}`);
  }
  console.log("\nTipos de adjunto:", JSON.stringify(tipos));
}
main().catch((e) => console.log("ERR", e?.message ?? e));
