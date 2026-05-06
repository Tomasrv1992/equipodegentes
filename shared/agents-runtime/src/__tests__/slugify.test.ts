import { describe, it, expect } from "vitest";
import { slugify } from "../slugify";

describe("slugify", () => {
  it("convierte a minúsculas y reemplaza espacios por guiones", () => {
    expect(slugify("Sin Bata Co.")).toBe("sin-bata-co");
  });

  it("quita acentos", () => {
    expect(slugify("La Dentistería")).toBe("la-dentisteria");
  });

  it("colapsa múltiples separadores", () => {
    expect(slugify("Foo   --   Bar")).toBe("foo-bar");
  });

  it("recorta guiones de los extremos", () => {
    expect(slugify("  -hello-  ")).toBe("hello");
  });

  it("ignora caracteres no alfanuméricos", () => {
    expect(slugify("Hello, World! 123")).toBe("hello-world-123");
  });

  it("retorna string vacío para input vacío", () => {
    expect(slugify("")).toBe("");
  });
});
