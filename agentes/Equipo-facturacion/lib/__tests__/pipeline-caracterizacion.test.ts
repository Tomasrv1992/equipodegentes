// Tests de CARACTERIZACIÓN de pipeline.ts.
//
// Objetivo: congelar el comportamiento ACTUAL de las funciones puras/aislables
// como red de seguridad antes de un futuro refactor (split de pipeline.ts).
// Documentan lo que el código HACE hoy, no lo que debería hacer. Fixtures 100%
// sintéticos (NITs/CUFEs inventados, XML DIAN mínimo). Cero datos reales.
//
// Funciones internas expuestas con `export` para poder testearlas (cambio
// inocuo, sin tocar su lógica): isDuplicate, normalizeProveedorName,
// isSelfEmitted, buildFileBaseName, asNumber, asString, parseInvoiceXml.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import {
  mapMotivoToLabel,
  normalizeProveedorName,
  isDuplicate,
  isSelfEmitted,
  buildFileBaseName,
  asNumber,
  asString,
  parseInvoiceXml,
} from "../pipeline";

// ===== mapMotivoToLabel =====
describe("mapMotivoToLabel", () => {
  it("motivos de duplicado -> Duplicado/<year>; el resto -> Descartado/<year>", () => {
    expect(mapMotivoToLabel("dup-en-sheet", 2026)).toBe("Duplicado/2026");
    expect(mapMotivoToLabel("dup-constraint-bd", 2026)).toBe("Duplicado/2026");
    expect(mapMotivoToLabel("cualquier-cosa", 2025)).toBe("Descartado/2025");
    expect(mapMotivoToLabel("planilla-ss-tercero", 2026)).toBe("Descartado/2026");
  });
});

// ===== normalizeProveedorName =====
describe("normalizeProveedorName", () => {
  it("string vacio o null -> ''", () => {
    expect(normalizeProveedorName("")).toBe("");
    expect(normalizeProveedorName(undefined as unknown as string)).toBe("");
  });
  it("quita sufijo S.A.S y baja a minusculas", () => {
    expect(normalizeProveedorName("DENTILANDIA S.A.S")).toBe("dentilandia");
    expect(normalizeProveedorName("Dentilandia SAS")).toBe("dentilandia");
  });
  it("quita acentos", () => {
    expect(normalizeProveedorName("Tomás Ramírez Villa")).toBe("tomas ramirez villa");
  });
  it("quita Ltda y colapsa espacios/puntuacion", () => {
    expect(normalizeProveedorName("Comercial  Ltda.")).toBe("comercial");
  });
});

// ===== isDuplicate (esquema sin col "#": 0=Fecha, 1=proveedor, 2=nit, 3=numero) =====
describe("isDuplicate", () => {
  const row = (proveedor: string, nit: string, numero: string) => ["", proveedor, nit, numero];

  it("numero vacio -> false (no se puede deduplicar)", () => {
    expect(isDuplicate([row("Prov", "900", "FE1")], "", "900", "Prov")).toBe(false);
  });
  it("mismo numero + mismo NIT -> true", () => {
    expect(isDuplicate([row("Prov", "900123456", "FE1")], "FE1", "900123456", "Prov")).toBe(true);
  });
  it("mismo numero pero NIT distinto -> false", () => {
    expect(isDuplicate([row("Prov", "900123456", "FE1")], "FE1", "111111111", "Prov")).toBe(false);
  });
  it("mismo numero, sin NIT en ninguno, mismo proveedor -> true", () => {
    expect(isDuplicate([row("Comercial SAS", "", "FE1")], "FE1", "", "Comercial S.A.S")).toBe(true);
  });
  it("mismo numero, sin NIT, proveedor distinto -> false", () => {
    expect(isDuplicate([row("Comercial SAS", "", "FE1")], "FE1", "", "Otra Empresa")).toBe(false);
  });
  it("numero no presente en las filas -> false", () => {
    expect(isDuplicate([row("Prov", "900", "FE1")], "FE2", "900", "Prov")).toBe(false);
  });
  it("mismo numero, sin NIT ni proveedor -> true (conservador)", () => {
    expect(isDuplicate([row("", "", "FE1")], "FE1", "", undefined)).toBe(true);
  });
});

// ===== isSelfEmitted =====
describe("isSelfEmitted", () => {
  it("NIT extraido === nitCliente -> true (con o sin DV/formato)", () => {
    expect(isSelfEmitted("Cualquiera", "900.123.456", "900123456", null)).toBe(true);
  });
  it("nombre del proveedor coincide con nombreClienteNorm -> true", () => {
    expect(isSelfEmitted("DENTILANDIA SAS", undefined, null, "dentilandia")).toBe(true);
  });
  it("nombreClienteNorm contenido en el proveedor -> true (includes)", () => {
    expect(isSelfEmitted("Dentilandia Sede Norte", undefined, null, "dentilandia")).toBe(true);
  });
  it("ni NIT ni nombre coinciden -> false", () => {
    expect(isSelfEmitted("Proveedor Externo", "111", "900123456", "dentilandia")).toBe(false);
  });
});

// ===== buildFileBaseName =====
describe("buildFileBaseName", () => {
  it("con numero: '{numero}. {Proveedor Title Case}'", () => {
    expect(buildFileBaseName(1, "SEGUROS DE VIDA SURAMERICANA", "FEL428843")).toBe(
      "FEL428843. Seguros De Vida Suramericana",
    );
  });
  it("sin numero: solo el proveedor en title case", () => {
    expect(buildFileBaseName(1, "sin proveedor", null)).toBe("Sin Proveedor");
  });
  it("con subIdx: '{numero}.{subIdx}. {Proveedor}'", () => {
    expect(buildFileBaseName(1, "Test", "FE1", 2)).toBe("FE1.2. Test");
  });
  it("sanitiza caracteres ilegales de filename en el numero", () => {
    expect(buildFileBaseName(1, "Prov", "FE/1:2")).toBe("FE-1-2. Prov");
  });
});

// ===== asNumber / asString (helpers de parseo XML) =====
describe("asNumber", () => {
  it("null/undefined -> 0", () => {
    expect(asNumber(null)).toBe(0);
    expect(asNumber(undefined)).toBe(0);
  });
  it("number pasa directo", () => {
    expect(asNumber(1234)).toBe(1234);
  });
  it("string numerica -> number", () => {
    expect(asNumber("100000")).toBe(100000);
  });
  it("objeto con #text -> parseFloat del #text", () => {
    expect(asNumber({ "#text": "50" })).toBe(50);
  });
  it("string no numerica -> 0", () => {
    expect(asNumber("no-es-numero")).toBe(0);
  });
});

describe("asString", () => {
  it("null -> ''", () => {
    expect(asString(null)).toBe("");
  });
  it("number -> string", () => {
    expect(asString(5)).toBe("5");
  });
  it("objeto con #text -> #text como string", () => {
    expect(asString({ "#text": "FE123" })).toBe("FE123");
  });
});

// ===== parseInvoiceXml (con fixture XML DIAN mínimo, sintético) =====
const PARSER = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

let tmpCounter = 0;
function writeTmpXml(content: string): string {
  const p = path.join(os.tmpdir(), `caract-pipeline-${process.pid}-${tmpCounter++}.xml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const facturaXml = (tipoDoc = "01", supplierNit = "900123456") => `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <ID>FE12345</ID>
  <UUID>cufe-sintetico-abc-123</UUID>
  <IssueDate>2026-03-15</IssueDate>
  <InvoiceTypeCode>${tipoDoc}</InvoiceTypeCode>
  <AccountingSupplierParty>
    <Party>
      <PartyTaxScheme>
        <RegistrationName>Proveedor Test SAS</RegistrationName>
        <CompanyID>${supplierNit}</CompanyID>
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <LegalMonetaryTotal>
    <LineExtensionAmount>100000</LineExtensionAmount>
    <PayableAmount>119000</PayableAmount>
  </LegalMonetaryTotal>
  <TaxTotal>
    <TaxAmount>19000</TaxAmount>
    <TaxSubtotal>
      <TaxAmount>19000</TaxAmount>
      <TaxCategory>
        <TaxScheme>
          <ID>01</ID>
        </TaxScheme>
      </TaxCategory>
    </TaxSubtotal>
  </TaxTotal>
  <InvoiceLine>
    <Item>
      <Description>Servicio de prueba</Description>
    </Item>
  </InvoiceLine>
</Invoice>`;

describe("parseInvoiceXml", () => {
  it("factura DIAN tipo 01 -> extrae numero, cufe, proveedor, nit, montos, fecha, concepto", () => {
    const p = writeTmpXml(facturaXml("01"));
    const data = parseInvoiceXml(p, PARSER);
    expect(data).not.toBeNull();
    expect(data!.numero).toBe("FE12345");
    expect(data!.cufe).toBe("cufe-sintetico-abc-123");
    expect(data!.proveedor).toBe("Proveedor Test SAS");
    expect(data!.nit).toBe("900123456");
    expect(data!.fecha).toBe("2026-03-15");
    expect(data!.subtotal).toBe(100000);
    expect(data!.iva).toBe(19000);
    expect(data!.total).toBe(119000); // PayableAmount
    expect(data!.concepto).toBe("Servicio de prueba");
    expect(data!.totalRetenciones).toBe(0);
  });

  it("tipo de documento 91 (nota credito) -> null (no es factura de compra)", () => {
    const p = writeTmpXml(facturaXml("91"));
    expect(parseInvoiceXml(p, PARSER)).toBeNull();
  });

  it("supplier NIT === nitCliente -> null (auto-factura: el cliente es el emisor)", () => {
    const p = writeTmpXml(facturaXml("01", "901117356"));
    expect(parseInvoiceXml(p, PARSER, "901117356")).toBeNull();
  });
});
