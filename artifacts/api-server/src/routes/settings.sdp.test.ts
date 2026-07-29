// Tests for the /settings/sdp GET/PUT round-trip, focusing on the
// onCreateStatusName field: default value, trimming on save, empty-string
// disable, and preserving the stored value when the field is omitted.
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, ADMIN_SESSION } from "./test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  smtpSettingsTable: { _t: "smtp_settings", key: "key" },
  ldapSettingsTable: { _t: "ldap_settings", key: "key" },
  sslSettingsTable: { _t: "ssl_settings", key: "key" },
  sdpSettingsTable: { _t: "sdp_settings", key: "key" },
  notificationQueueTable: { _t: "notification_queue", sentAt: "sent_at" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  isNull: () => ({}),
}));

vi.mock("../lib/auth", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/email", () => ({ sendTestEmail: vi.fn() }));
vi.mock("../lib/ldap", () => ({ testLdapConnection: vi.fn() }));
vi.mock("../lib/csr", () => ({ generateCsr: vi.fn() }));
vi.mock("../lib/sdp", () => ({ testSdpConnection: vi.fn() }));
vi.mock("../lib/secret-crypto", () => ({ encryptSecret: vi.fn((s: string) => `enc(${s})`) }));
vi.mock("../lib/notification-worker", () => ({
  flushNotificationQueue: vi.fn(),
  getNotificationSettings: vi.fn(),
  getQueueDepth: vi.fn(),
  setNotificationSettings: vi.fn(),
}));

const { default: settingsRouter } = await import("./settings");

const storedRow = {
  key: "global",
  enabled: true,
  baseUrl: "https://sdp.example.org",
  technicianKeyEnc: "enc(key)",
  webhookSecret: "hook-secret",
  tlsRejectUnauthorized: true,
  onCreateStatusName: "Custom Status",
  lastWebhookAt: null,
  lastWebhookRequestId: null,
  lastWebhookStatus: null,
};

// The values object handed to .values() / .onConflictDoUpdate() by the PUT.
function putValues(): Record<string, unknown> {
  const entry = dbMock.log.find((e) => e.call === "insert" && e.method === "values");
  expect(entry, "insert .values(...) call").toBeTruthy();
  return entry!.args[0] as Record<string, unknown>;
}

describe("GET /settings/sdp", () => {
  beforeEach(() => dbMock.reset());

  it("returns defaults (incl. default onCreateStatusName) when no row exists", async () => {
    dbMock.enqueue("select", []);
    const app = buildTestApp(settingsRouter, ADMIN_SESSION);
    const res = await request(app).get("/api/settings/sdp");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      baseUrl: "",
      technicianKeySet: false,
      onCreateStatusName: "Waiting for Change-it",
      lastWebhookAt: null,
    });
  });

  it("returns the stored row masked (technician key never leaves the server)", async () => {
    dbMock.enqueue("select", [storedRow]);
    const app = buildTestApp(settingsRouter, ADMIN_SESSION);
    const res = await request(app).get("/api/settings/sdp");
    expect(res.status).toBe(200);
    expect(res.body.onCreateStatusName).toBe("Custom Status");
    expect(res.body.technicianKeySet).toBe(true);
    expect(res.body).not.toHaveProperty("technicianKeyEnc");
  });
});

describe("PUT /settings/sdp — onCreateStatusName round-trip", () => {
  beforeEach(() => dbMock.reset());

  function run(body: Record<string, unknown>, before: unknown[], returned = storedRow) {
    dbMock.enqueue("select", before); // load `before` row
    dbMock.enqueue("insert", [returned]); // upsert .returning()
    const app = buildTestApp(settingsRouter, ADMIN_SESSION);
    return request(app).put("/api/settings/sdp").send(body);
  }

  it("defaults onCreateStatusName to 'Waiting for Change-it' on first save when omitted", async () => {
    const res = await run({ enabled: true, baseUrl: "https://sdp.example.org/" }, []);
    expect(res.status).toBe(200);
    expect(putValues().onCreateStatusName).toBe("Waiting for Change-it");
    // trailing slash on baseUrl stripped too
    expect(putValues().baseUrl).toBe("https://sdp.example.org");
  });

  it("trims the submitted status name before saving", async () => {
    const res = await run(
      { enabled: true, baseUrl: "https://sdp.example.org", onCreateStatusName: "  Change Prepared  " },
      [storedRow],
    );
    expect(res.status).toBe(200);
    expect(putValues().onCreateStatusName).toBe("Change Prepared");
  });

  it("accepts an empty string as a valid value (disables the on-create status update)", async () => {
    const returned = { ...storedRow, onCreateStatusName: "" };
    const res = await run(
      { enabled: true, baseUrl: "https://sdp.example.org", onCreateStatusName: "" },
      [storedRow],
      returned,
    );
    expect(res.status).toBe(200);
    expect(putValues().onCreateStatusName).toBe("");
    expect(res.body.onCreateStatusName).toBe("");
  });

  it("preserves the previously stored status name when the field is omitted", async () => {
    const res = await run({ enabled: true, baseUrl: "https://sdp.example.org" }, [storedRow]);
    expect(res.status).toBe(200);
    expect(putValues().onCreateStatusName).toBe("Custom Status");
    // non-string values are ignored the same way
    dbMock.reset();
    const res2 = await run(
      { enabled: true, baseUrl: "https://sdp.example.org", onCreateStatusName: 42 },
      [storedRow],
    );
    expect(res2.status).toBe(200);
    expect(putValues().onCreateStatusName).toBe("Custom Status");
  });

  it("keeps the existing webhook secret and does not regenerate it on update", async () => {
    const res = await run({ enabled: true, baseUrl: "https://sdp.example.org" }, [storedRow]);
    expect(res.status).toBe(200);
    expect(putValues().webhookSecret).toBe("hook-secret");
  });
});
