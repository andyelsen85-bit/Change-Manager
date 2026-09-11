import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { DbMock, buildTestApp, ADMIN_SESSION } from "./test-helpers";

const dbMock = new DbMock();
const audit = vi.fn().mockResolvedValue(undefined);
const getAdfsConfig = vi.fn();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  smtpSettingsTable: { _t: "smtp", key: "key" },
  ldapSettingsTable: { _t: "ldap", key: "key" },
  adfsSettingsTable: { _t: "adfs", key: "key" },
  sslSettingsTable: { _t: "ssl", key: "key" },
  sdpSettingsTable: { _t: "sdp", key: "key" },
  notificationQueueTable: { _t: "queue", sentAt: "sent_at" },
}));
vi.mock("drizzle-orm", () => ({ eq: () => ({}), isNull: () => ({}) }));
vi.mock("../lib/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../lib/audit", () => ({ audit }));
vi.mock("../lib/email", () => ({ sendTestEmail: vi.fn() }));
vi.mock("../lib/ldap", () => ({ testLdapConnection: vi.fn() }));
vi.mock("../lib/csr", () => ({ generateCsr: vi.fn() }));
vi.mock("../lib/sdp", () => ({ testSdpConnection: vi.fn() }));
vi.mock("../lib/secret-crypto", () => ({
  encryptSecret: vi.fn((value: string) => `enc(${value})`),
  decryptSecret: vi.fn((value: string) => value.startsWith("enc(") ? value.slice(4, -1) : value),
}));
vi.mock("../lib/adfs", () => ({
  getAdfsConfig,
  normalizeScopes: (value: string) => value.includes("openid") ? value : `openid ${value}`.trim(),
  validateAdfsSettingsInput: () => null,
}));
vi.mock("../lib/notification-worker", () => ({
  flushNotificationQueue: vi.fn(), getNotificationSettings: vi.fn(), getQueueDepth: vi.fn(), setNotificationSettings: vi.fn(),
}));

const { default: settingsRouter } = await import("./settings");

const envEffective = {
  enabled: false, displayName: "Sign in with AD FS", issuer: "", discoveryUrl: "", clientId: "",
  clientSecretEnc: "env-secret", redirectUri: "", scopes: "openid profile email",
  usernameClaim: "upn", emailClaim: "email", displayNameClaim: "name", caCertPem: "ENV CA",
};
const saved = {
  key: "global", enabled: true, displayName: "AD FS", issuer: "https://adfs.example.test",
  discoveryUrl: "", clientId: "client", clientSecretEnc: "enc(saved)", redirectUri: "https://cm.example.test/callback",
  scopes: "openid profile", usernameClaim: "upn", emailClaim: "email", displayNameClaim: "name", caCertPem: "SAVED CA",
};

function insertedValues(): Record<string, unknown> {
  const call = dbMock.log.find((entry) => entry.call === "insert" && entry.method === "values");
  expect(call).toBeTruthy();
  return call!.args[0] as Record<string, unknown>;
}

describe("AD FS settings secrecy and update semantics", () => {
  beforeEach(() => {
    dbMock.reset();
    audit.mockClear();
    getAdfsConfig.mockResolvedValue(envEffective);
  });

  it("never returns the stored secret or PEM", async () => {
    dbMock.enqueue("select", [saved]);
    const response = await request(buildTestApp(settingsRouter, ADMIN_SESSION)).get("/api/settings/adfs");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ secretConfigured: true, caConfigured: true, clientId: "client" });
    expect(response.body).not.toHaveProperty("clientSecretEnc");
    expect(response.body).not.toHaveProperty("caCertPem");
    expect(JSON.stringify(response.body)).not.toContain("saved");
    expect(JSON.stringify(response.body)).not.toContain("SAVED CA");
  });

  it("preserves effective environment secret/CA on an initial omitted save, encrypted", async () => {
    dbMock.enqueue("select", []);
    dbMock.enqueue("insert", [{ ...saved, clientSecretEnc: "enc(env-secret)", caCertPem: "ENV CA" }]);
    const response = await request(buildTestApp(settingsRouter, ADMIN_SESSION))
      .put("/api/settings/adfs").send({ enabled: true, clientId: "client" });
    expect(response.status).toBe(200);
    expect(insertedValues()).toMatchObject({ clientSecretEnc: "enc(env-secret)", caCertPem: "ENV CA" });
  });

  it("does not clear a saved secret from an empty string, while null explicitly clears secret and CA", async () => {
    dbMock.enqueue("select", [saved]);
    getAdfsConfig.mockResolvedValue(saved);
    dbMock.enqueue("insert", [saved]);
    const keep = await request(buildTestApp(settingsRouter, ADMIN_SESSION))
      .put("/api/settings/adfs").send({ clientSecret: "" });
    expect(keep.status).toBe(200);
    expect(insertedValues().clientSecretEnc).toBe("enc(saved)");

    dbMock.reset();
    dbMock.enqueue("select", [saved]);
    dbMock.enqueue("insert", [{ ...saved, clientSecretEnc: null, caCertPem: null }]);
    const clear = await request(buildTestApp(settingsRouter, ADMIN_SESSION))
      .put("/api/settings/adfs").send({ clientSecret: null, caCertPem: null });
    expect(clear.status).toBe(200);
    expect(insertedValues()).toMatchObject({ clientSecretEnc: null, caCertPem: null });
  });
});