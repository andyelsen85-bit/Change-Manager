// Tests for sdpSetInitialStatus — the best-effort "Waiting for Change-it"
// status write-back into ServiceDesk Plus right after a change is created
// from a ticket. Covers the disabled/blank short-circuits, the happy path
// (trimmed status name, correct SD+ endpoint/payload) and failure logging.
import { describe, it, expect, beforeEach, vi } from "vitest";

const selectResults: unknown[][] = [];

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          const next = selectResults.shift();
          if (!next) throw new Error("no queued select result");
          return next;
        },
      }),
    }),
  },
  sdpSettingsTable: { _t: "sdp_settings", key: "key" },
  auditLogTable: { _t: "audit_log" },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("./secret-crypto", () => ({ decryptSecret: vi.fn().mockReturnValue("tech-key") }));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
vi.mock("./logger", () => ({ logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: (...a: unknown[]) => loggerWarn(...a) } }));

const fetchMock = vi.fn();
vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  Agent: class {},
}));

const { sdpSetInitialStatus } = await import("./sdp");

const baseCfg = {
  key: "global",
  enabled: true,
  baseUrl: "https://sdp.example.org/",
  technicianKeyEnc: "enc",
  webhookSecret: "s",
  tlsRejectUnauthorized: true,
  onCreateStatusName: "Waiting for Change-it",
  lastWebhookAt: null,
  lastWebhookRequestId: null,
  lastWebhookStatus: null,
};

describe("sdpSetInitialStatus", () => {
  beforeEach(() => {
    selectResults.length = 0;
    fetchMock.mockReset();
    loggerInfo.mockReset();
    loggerWarn.mockReset();
  });

  it("does nothing when no SD+ config row exists", async () => {
    selectResults.push([]);
    await sdpSetInitialStatus("101");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does nothing when the integration is disabled", async () => {
    selectResults.push([{ ...baseCfg, enabled: false }]);
    await sdpSetInitialStatus("101");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("short-circuits when the configured status name is blank/whitespace", async () => {
    selectResults.push([{ ...baseCfg, onCreateStatusName: "   " }]);
    await sdpSetInitialStatus("101");
    expect(fetchMock).not.toHaveBeenCalled();

    selectResults.push([{ ...baseCfg, onCreateStatusName: "" }]);
    await sdpSetInitialStatus("101");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("PUTs the trimmed status name to the SD+ request endpoint on success", async () => {
    selectResults.push([{ ...baseCfg, onCreateStatusName: "  Waiting for Change-it  " }]);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "{}" });

    await sdpSetInitialStatus("123 456");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string; headers: Record<string, string> }];
    // Base URL trailing slash stripped, request id URL-encoded.
    expect(url).toBe("https://sdp.example.org/api/v3/requests/123%20456");
    expect(init.method).toBe("PUT");
    const inputData = JSON.parse(new URLSearchParams(init.body).get("input_data")!);
    expect(inputData).toEqual({ request: { status: { name: "Waiting for Change-it" } } });
    expect(init.headers.technician_key).toBe("tech-key");
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "123 456", statusName: "Waiting for Change-it" }),
      expect.stringMatching(/status set/i),
    );
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("logs a warning (and does not throw) when SD+ rejects the status update", async () => {
    selectResults.push([baseCfg]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"message":"no such status"}' });

    await expect(sdpSetInitialStatus("77")).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "77", statusName: "Waiting for Change-it", status: 400 }),
      expect.stringMatching(/failed/i),
    );
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it("logs a warning (and does not throw) when the network call throws", async () => {
    selectResults.push([baseCfg]);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(sdpSetInitialStatus("88")).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "88", err: expect.stringContaining("fetch failed") }),
      expect.stringMatching(/failed/i),
    );
  });
});
