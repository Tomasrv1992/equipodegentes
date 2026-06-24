// Conciliación LOCAL single-tenant (sin Supabase): compara las fuentes físicas
// Gmail (labels) vs Sheet (filas) vs Drive (PDFs) y escanea recibos de plataforma
// que hayan quedado en Descartado. Veredicto: ¿cuadra correos = facturas?
import { google } from "googleapis";

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const ATTACH = "(filename:zip OR filename:pdf OR filename:docx OR filename:autoliquidaciones OR filename:comprobante)";
const DOMINIOS_GASTO = ["anthropic.com","openai.com","google.com","stripe.com","paypal.com","amazonaws.com","amazon.com","meta.com","facebook.com","notion.so","github.com","microsoft.com","azure.com","slack.com","zoom.us","figma.com","adobe.com","dropbox.com","shopify.com","vercel.com","netlify.com","cloudflare.com"];

async function main() {
  const year = Number(process.argv[2]) || new Date().getFullYear();
  const a = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  a.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const gmail = google.gmail({ version: "v1", auth: a });
  const sheets = google.sheets({ version: "v4", auth: a });
  const drive = google.drive({ version: "v3", auth: a });

  const me = await gmail.users.getProfile({ userId: "me" });
  const countQ = async (q: string) => { let t = 0, pt: any; do { const r: any = await gmail.users.messages.list({ userId: "me", q, maxResults: 500, pageToken: pt }); t += (r.data.messages ?? []).length; pt = r.data.nextPageToken; } while (pt); return t; };

  // GMAIL
  const fac = await countQ(`label:Facturas/${year}`);
  const des = await countQ(`label:Descartado/${year}`);
  const dup = await countQ(`label:Duplicado/${year}`);
  const sinLabel = await countQ(`${ATTACH} after:${year}/01/01 -label:Facturas/${year} -label:Descartado/${year} -label:Duplicado/${year}`);

  // SHEET
  const sr = await sheets.spreadsheets.values.batchGet({ spreadsheetId: process.env.INVOICES_SHEET_ID!, ranges: MESES.map(m => `'${m}'!D2:D`) });
  let sheetTot = 0; const sheetByMonth: Record<string, number> = {};
  (sr.data.valueRanges ?? []).forEach((vr, i) => { const n = (vr.values ?? []).filter((x: any) => String(x[0] ?? "").trim()).length; if (n) sheetByMonth[MESES[i]] = n; sheetTot += n; });

  // DRIVE (subcarpetas YYYY-MM)
  const sub = await drive.files.list({ q: `'${process.env.INVOICES_DRIVE_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: "files(id,name)" });
  let driveTot = 0;
  for (const f of sub.data.files ?? []) {
    let c = 0, pt: any; do { const r: any = await drive.files.list({ q: `'${f.id}' in parents and trashed=false and mimeType='application/pdf'`, fields: "nextPageToken,files(id)", pageSize: 1000, pageToken: pt }); c += (r.data.files ?? []).length; pt = r.data.nextPageToken; } while (pt);
    driveTot += c;
  }

  // RECIBOS DE PLATAFORMA en Descartado (los que NO deberían haberse botado)
  const fromFilter = DOMINIOS_GASTO.map(d => `from:${d}`).join(" OR ");
  const platDescartados = await countQ(`label:Descartado/${year} (${fromFilter})`);

  console.log(`\n================ CONCILIACIÓN ${me.data.emailAddress} · ${year} ================\n`);
  console.log(`GMAIL  Facturas/${year}:   ${fac}`);
  console.log(`GMAIL  Duplicado/${year}:  ${dup}   (misma factura reenviada → evidencia)`);
  console.log(`GMAIL  Descartado/${year}: ${des}`);
  console.log(`GMAIL  sin etiquetar (pendientes): ${sinLabel}`);
  console.log(`       UNIVERSO (Fac+Dup+Desc): ${fac + dup + des}\n`);
  console.log(`SHEET  filas (facturas registradas): ${sheetTot}`);
  console.log(`DRIVE  PDFs archivados:              ${driveTot}\n`);
  console.log(`--- CUADRE ---`);
  console.log(`Facturas(Gmail) vs Sheet:  ${fac} vs ${sheetTot}  -> dif ${fac - sheetTot}  (debe ser ~0)`);
  console.log(`Duplicados (reenvíos):     ${dup}`);
  console.log(`Sheet vs Drive:            ${sheetTot} vs ${driveTot} -> dif ${sheetTot - driveTot}`);
  console.log(`Pendientes sin procesar:   ${sinLabel}`);
  console.log(`\n--- RECIBOS DE PLATAFORMA mal descartados: ${platDescartados} ---`);
  console.log(`(deberían ser ~0; si hay, son gastos que el clasificador botó)\n`);
  console.log(`Filas por mes:`, JSON.stringify(sheetByMonth));
}
main().catch((e) => console.log("ERR", e?.message ?? e));
