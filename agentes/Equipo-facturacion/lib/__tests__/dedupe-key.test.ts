import { describe, it, expect } from "vitest";
import { calcularDedupeKey } from "../../../../shared/agents-runtime/src/dedupe-key";

// dedupe_key = CUFE si la factura DIAN lo trae; gmail message id en cualquier
// otro caso (CUFE ausente/vacío, o documento no-DIAN). Ver migración 0018.
describe("calcularDedupeKey", () => {
  it("CUFE presente → usa el CUFE (factura DIAN)", () => {
    expect(calcularDedupeKey({ cufe: "abc123CUFE", gmailMessageId: "msg1" })).toBe("abc123CUFE");
  });

  it("CUFE undefined → usa el gmail messageId (documento no-DIAN)", () => {
    expect(calcularDedupeKey({ gmailMessageId: "msg1" })).toBe("msg1");
  });

  it("CUFE null → usa el gmail messageId", () => {
    expect(calcularDedupeKey({ cufe: null, gmailMessageId: "msg1" })).toBe("msg1");
  });

  it("CUFE string vacío → usa el gmail messageId", () => {
    expect(calcularDedupeKey({ cufe: "", gmailMessageId: "msg1" })).toBe("msg1");
  });

  it("CUFE solo espacios → trim queda vacío → usa el gmail messageId", () => {
    expect(calcularDedupeKey({ cufe: "   ", gmailMessageId: "msg1" })).toBe("msg1");
  });

  it("CUFE con espacios alrededor → devuelve el CUFE trimmeado", () => {
    expect(calcularDedupeKey({ cufe: "  CUFE9  ", gmailMessageId: "msg1" })).toBe("CUFE9");
  });

  it("CUFE presente NO cae al messageId aunque ambos estén", () => {
    expect(calcularDedupeKey({ cufe: "X", gmailMessageId: "Y" })).toBe("X");
  });
});
