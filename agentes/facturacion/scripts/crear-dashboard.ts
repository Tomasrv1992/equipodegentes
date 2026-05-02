// One-off: crea pestaña "Dashboard" en el spreadsheet de gastos.
// Métricas vivas (fórmulas) que se actualizan solas cuando llegan facturas nuevas.
//
// Uso: npx tsx --env-file=.env.local scripts/crear-dashboard.ts

import { google } from "googleapis";

const TAB_NAME = "Dashboard";
const SOURCE_TAB = "Gastos 2026";

async function main() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.INVOICES_SHEET_ID!;

  // 1. Crear (o reusar) el tab Dashboard
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = meta.data.sheets || [];
  let tab = tabs.find((s) => s.properties?.title === TAB_NAME);

  if (!tab) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: TAB_NAME,
              gridProperties: { rowCount: 50, columnCount: 8, frozenRowCount: 1 },
              tabColor: { red: 0.2, green: 0.5, blue: 0.9 },
            },
          },
        }],
      },
    });
    const newSheet = created.data.replies?.[0]?.addSheet?.properties;
    if (!newSheet?.sheetId) throw new Error("No se pudo crear el tab");
    tab = { properties: newSheet };
    console.log(`✓ Tab "${TAB_NAME}" creado`);
  } else {
    console.log(`- Tab "${TAB_NAME}" ya existía, se sobreescribirán contenidos`);
  }
  const sheetId = tab.properties!.sheetId!;

  const src = `'${SOURCE_TAB}'`;

  // 2. Construir contenido (fórmulas vivas)
  const months = [
    ["2026-01", "Enero",   1],
    ["2026-02", "Febrero", 2],
    ["2026-03", "Marzo",   3],
    ["2026-04", "Abril",   4],
    ["2026-05", "Mayo",    5],
    ["2026-06", "Junio",   6],
    ["2026-07", "Julio",   7],
    ["2026-08", "Agosto",  8],
    ["2026-09", "Septiembre", 9],
    ["2026-10", "Octubre", 10],
    ["2026-11", "Noviembre", 11],
    ["2026-12", "Diciembre", 12],
  ];

  // ⚠️ Locale es-CO usa `;` como separador de argumentos en vez de `,`.
  const monthRows = months.map(([code, name, m]) => {
    const start = `DATE(2026;${m};1)`;
    const end = `EOMONTH(DATE(2026;${m};1);0)`;
    return [
      name as string,
      `=COUNTIFS(${src}!A:A;">="&${start};${src}!A:A;"<="&${end})`,
      `=SUMIFS(${src}!E:E;${src}!A:A;">="&${start};${src}!A:A;"<="&${end})`,
      `=SUMIFS(${src}!F:F;${src}!A:A;">="&${start};${src}!A:A;"<="&${end})`,
      `=SUMIFS(${src}!G:G;${src}!A:A;">="&${start};${src}!A:A;"<="&${end})`,
    ];
  });

  // Filas del Sheet — todas explícitas para mantener layout legible
  const rows: any[][] = [
    ["DASHBOARD GASTOS 2026", "", "", "", ""],                                                                  // 1
    ["Actualizado en vivo desde el tab \"Gastos 2026\"", "", "", "", ""],                                        // 2
    ["", "", "", "", ""],                                                                                          // 3
    ["📊 KPIs Anuales", "", "", "", ""],                                                                          // 4
    ["Total facturas",       `=COUNTA(${src}!B2:B)`, "", "", ""],                                                 // 5
    ["Total gastado",        `=SUM(${src}!G:G)`, "", "", ""],                                                      // 6
    ["Promedio por factura", `=IFERROR(AVERAGE(${src}!G2:G);0)`, "", "", ""],                                      // 7
    ["IVA acumulado",        `=SUM(${src}!F:F)`, "", "", ""],                                                      // 8
    ["Subtotal acumulado",   `=SUM(${src}!E:E)`, "", "", ""],                                                      // 9
    ["", "", "", "", ""],                                                                                          // 10
    ["📅 Gastos por mes", "", "", "", ""],                                                                         // 11
    ["Mes", "# Facturas", "Subtotal", "IVA", "Total"],                                                             // 12 — headers
    ...monthRows,                                                                                                  // 13-24
    ["TOTAL", `=SUM(B13:B24)`, `=SUM(C13:C24)`, `=SUM(D13:D24)`, `=SUM(E13:E24)`],                                // 25
    ["", "", "", "", ""],                                                                                          // 26
    ["🏆 Top 10 proveedores", "", "", "", ""],                                                                    // 27
    ["Proveedor", "# Facturas", "Total", "", ""],                                                                  // 28 — headers
    [`=IFERROR(QUERY(${src}!B:G;"select B, count(B), sum(G) where B is not null and B<>'Proveedor' group by B order by sum(G) desc limit 10 label B '', count(B) '', sum(G) ''";0);"sin datos")`, "", "", "", ""], // 29 — la query expande hacia abajo
  ];

  // 3. Escribir todo de una vez
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB_NAME}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
  console.log(`✓ ${rows.length} filas de contenido escritas`);

  // 4. Formato visual
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // Título principal (fila 1) — merged + bold + grande + fondo azul
        {
          mergeCells: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
            mergeType: "MERGE_ALL",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.4, blue: 0.7 },
                textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 1, green: 1, blue: 1 } },
                horizontalAlignment: "CENTER",
                verticalAlignment: "MIDDLE",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)",
          },
        },
        // Subtítulo fila 2 — italic gris
        {
          mergeCells: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 5 },
            mergeType: "MERGE_ALL",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 5 },
            cell: {
              userEnteredFormat: {
                textFormat: { italic: true, foregroundColor: { red: 0.5, green: 0.5, blue: 0.5 } },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(textFormat,horizontalAlignment)",
          },
        },
        // Sección headers (filas 4, 11, 27) — bold + fondo gris claro
        ...[3, 10, 26].map((row) => ({
          repeatCell: {
            range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: 5 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.93, green: 0.93, blue: 0.97 },
                textFormat: { bold: true, fontSize: 12 },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        })),
        // KPIs labels (filas 5-9 col A) — bold
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 4, endRowIndex: 9, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat",
          },
        },
        // KPIs values (filas 5-9 col B) — currency excepto fila 5
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 5, endRowIndex: 9, startColumnIndex: 1, endColumnIndex: 2 },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" },
                textFormat: { bold: true, fontSize: 12 },
              },
            },
            fields: "userEnteredFormat(numberFormat,textFormat)",
          },
        },
        // Total facturas (fila 5 col B) — número entero, no currency
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 1, endColumnIndex: 2 },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "NUMBER", pattern: "#,##0" },
                textFormat: { bold: true, fontSize: 12 },
              },
            },
            fields: "userEnteredFormat(numberFormat,textFormat)",
          },
        },
        // Headers tabla mensual (fila 12) — bold + fondo
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 11, endRowIndex: 12, startColumnIndex: 0, endColumnIndex: 5 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.85, green: 0.85, blue: 0.95 },
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
          },
        },
        // Tabla mensual: # facturas → number, montos → currency
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 12, endRowIndex: 25, startColumnIndex: 1, endColumnIndex: 2 },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 12, endRowIndex: 25, startColumnIndex: 2, endColumnIndex: 5 },
            cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        // Fila TOTAL (fila 25) — bold + fondo destacado
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 24, endRowIndex: 25, startColumnIndex: 0, endColumnIndex: 5 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.4, blue: 0.7 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        // Headers Top 10 (fila 28)
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 27, endRowIndex: 28, startColumnIndex: 0, endColumnIndex: 3 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.85, green: 0.85, blue: 0.95 },
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
          },
        },
        // Top 10 cuerpo: # facturas (col B) número, total (col C) currency
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 28, endRowIndex: 39, startColumnIndex: 1, endColumnIndex: 2 },
            cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: "#,##0" }, horizontalAlignment: "CENTER" } },
            fields: "userEnteredFormat(numberFormat,horizontalAlignment)",
          },
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 28, endRowIndex: 39, startColumnIndex: 2, endColumnIndex: 3 },
            cell: { userEnteredFormat: { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } } },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        // Anchos de columnas
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 220 },
            fields: "pixelSize",
          },
        },
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 5 },
            properties: { pixelSize: 130 },
            fields: "pixelSize",
          },
        },
        // Alto de la fila título
        {
          updateDimensionProperties: {
            range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
            properties: { pixelSize: 40 },
            fields: "pixelSize",
          },
        },
      ],
    },
  });

  console.log("✓ Formato aplicado");
  console.log(`\n✅ Dashboard listo: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
