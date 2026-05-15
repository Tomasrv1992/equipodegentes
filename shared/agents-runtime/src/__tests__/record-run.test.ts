import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordRunStart, recordRunEnd } from "../record-run";

vi.mock("../supabase-server", () => {
  const mockSelect = vi.fn();
  const mockInsert = vi.fn(() => ({ select: mockSelect }));
  const mockUpdate = vi.fn(() => ({ eq: vi.fn(() => ({ select: mockSelect })) }));
  const mockEqSelect = vi.fn(() => ({ single: vi.fn() }));
  const mockSelectChain = vi.fn(() => ({ eq: mockEqSelect }));
  const mockFrom = vi.fn((table: string) => {
    if (table === "clientes") {
      return { select: mockSelectChain };
    }
    return { insert: mockInsert, update: mockUpdate };
  });

  return {
    getServerClient: () => ({ from: mockFrom }),
    __mocks: { mockFrom, mockInsert, mockUpdate, mockSelect, mockEqSelect, mockSelectChain },
  };
});

import * as serverModule from "../supabase-server";
const mocks = (serverModule as any).__mocks;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset cliente lookup default response
  mocks.mockEqSelect.mockReturnValue({
    single: () => Promise.resolve({ data: { id: "cli-uuid-1" }, error: null }),
  });
});

describe("recordRunStart", () => {
  it("inserta una fila con status=running y devuelve el run_id", async () => {
    mocks.mockSelect.mockResolvedValue({
      data: [{ id: "abc-123" }],
      error: null,
    });

    const id = await recordRunStart({
      clienteSlug: "owner",
      agenteId: "facturacion",
      triggeredBy: "cron",
    });

    expect(id).toBe("abc-123");
    expect(mocks.mockFrom).toHaveBeenCalledWith("agent_runs");
    expect(mocks.mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        cliente_id: "cli-uuid-1",
        agente_id: "facturacion",
        status: "running",
        triggered_by: "cron",
      })
    );
  });

  it("throws si Supabase devuelve error en insert", async () => {
    mocks.mockSelect.mockResolvedValue({
      data: null,
      error: { message: "boom" },
    });

    await expect(
      recordRunStart({ clienteSlug: "owner", agenteId: "facturacion" })
    ).rejects.toThrow("boom");
  });

  it("throws si el cliente slug no existe", async () => {
    mocks.mockEqSelect.mockReturnValue({
      single: () => Promise.resolve({ data: null, error: { message: "not found" } }),
    });

    await expect(
      recordRunStart({ clienteSlug: "noexiste", agenteId: "facturacion" })
    ).rejects.toThrow(/noexiste/);
  });
});

describe("recordRunEnd", () => {
  it("actualiza la fila con status=ok y duration_ms", async () => {
    mocks.mockSelect.mockResolvedValue({ data: [{}], error: null });

    await recordRunEnd({
      runId: "abc-123",
      status: "ok",
      summary: "5 facturas",
      durationMs: 1234,
    });

    expect(mocks.mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        summary: "5 facturas",
        duration_ms: 1234,
      })
    );
  });

  it("guarda error_message + stack cuando status=fail", async () => {
    mocks.mockSelect.mockResolvedValue({ data: [{}], error: null });

    await recordRunEnd({
      runId: "abc-123",
      status: "fail",
      durationMs: 100,
      error: new Error("invalid_grant"),
    });

    expect(mocks.mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "fail",
        error_message: "invalid_grant",
        error_stack: expect.stringContaining("Error: invalid_grant"),
      })
    );
  });
});
