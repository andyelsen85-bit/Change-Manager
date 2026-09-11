import { beforeEach, describe, expect, it, vi } from "vitest";
import { rootCertificates } from "node:tls";
import { generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import { DbMock } from "../routes/test-helpers";

const dbMock = new DbMock();

vi.mock("@workspace/db", () => ({
  db: dbMock,
  adfsSettingsTable: { _t: "adfs_settings", key: "key" },
  adfsAuthTransactionsTable: {
    _t: "adfs_auth_transactions",
    stateHash: "state_hash",
    configFingerprint: "config_fingerprint",
    expiresAt: "expires_at",
    consumedAt: "consumed_at",
  },
  usersTable: { _t: "users", username: "username", email: "email" },
}));

const adfs = await import("./adfs");

const baseConfig = {
  enabled: true,
  displayName: "AD FS",
  issuer: "https://adfs.example.test/adfs",
  discoveryUrl: "",
  clientId: "change-mgmt",
  clientSecretEnc: null,
  redirectUri: "https://cm.example.test/api/auth/adfs/callback",
  scopes: "openid profile email",
  usernameClaim: "upn",
  emailClaim: "email",
  displayNameClaim: "name",
  caCertPem: null,
};

const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherSigningKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...signingKey.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig" };

function signedIdToken(
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string | string[]; expiresIn?: number; notBefore?: number } = {},
  key = signingKey.privateKey,
  kid = "test-key",
): string {
  return jwt.sign(
    { sub: "stable-subject", nonce: "expected-nonce", ...claims },
    key,
    {
      algorithm: "RS256",
      keyid: kid,
      issuer: options.issuer ?? baseConfig.issuer,
      audience: options.audience ?? baseConfig.clientId,
      expiresIn: options.expiresIn ?? 60,
      ...(options.notBefore !== undefined ? { notBefore: options.notBefore } : {}),
    },
  );
}

describe("AD FS state and safe returns", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("signs state, validates it, and refuses a mismatched callback state", () => {
    const created = adfs.createAdfsState("/requests/456?tab=history#comments");
    expect(adfs.readAdfsState(created.signedCookie)).toMatchObject(created.state);
    expect(adfs.stateMatches(created.state.state, created.state.state)).toBe(true);
    expect(adfs.stateMatches(created.state.state, "attacker-state")).toBe(false);
    expect(adfs.readAdfsState(`${created.signedCookie}x`)).toBeNull();
  });

  it("expires state and consumes its shared database transaction only once", async () => {
    vi.useFakeTimers();
    const created = adfs.createAdfsState("/changes/123");
    dbMock.enqueue("delete", []);
    dbMock.enqueue("insert", []);
    await adfs.createAdfsStateTransaction(created.state.state, baseConfig);
    dbMock.enqueue("update", [{ stateHash: "hash" }]);
    await expect(adfs.consumeAdfsState(created.state.state, baseConfig)).resolves.toBe(true);
    dbMock.enqueue("update", []);
    await expect(adfs.consumeAdfsState(created.state.state, baseConfig)).resolves.toBe(false);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(adfs.readAdfsState(created.signedCookie)).toBeNull();
  });

  it("binds transactions to configuration affecting token redemption and claims", () => {
    expect(adfs.adfsConfigFingerprint(baseConfig)).not.toBe(
      adfs.adfsConfigFingerprint({ ...baseConfig, clientId: "other-client" }),
    );
    expect(adfs.adfsConfigFingerprint(baseConfig)).not.toBe(
      adfs.adfsConfigFingerprint({ ...baseConfig, usernameClaim: "preferred_username" }),
    );
  });

  it("preserves valid local paths and rejects open redirect / injection inputs", () => {
    expect(adfs.sanitizeReturnTo("/requests/456?tab=history#comments")).toBe("/requests/456?tab=history#comments");
    expect(adfs.sanitizeReturnTo("https://evil.example/path")).toBe("/");
    expect(adfs.sanitizeReturnTo("//evil.example/path")).toBe("/");
    expect(adfs.sanitizeReturnTo("/\\evil")).toBe("/");
    expect(adfs.sanitizeReturnTo("/ok%0d%0aSet-Cookie:x")).toBe("/");
    expect(adfs.sanitizeReturnTo("/%2f%2fevil.example")).toBe("/");
    expect(adfs.sanitizeReturnTo("/bad%")).toBe("/");
  });
});

describe("AD FS configuration and claim mapping", () => {
  it("always includes openid and requires secure issuer configuration", () => {
    expect(adfs.normalizeScopes("profile email")).toBe("openid profile email");
    expect(adfs.isAdfsConfigured(baseConfig)).toBe(true);
    expect(adfs.isAdfsConfigured({ ...baseConfig, issuer: "http://adfs.example.test" })).toBe(false);
  });

  it("maps configured claims and fails when no identity claim is present", () => {
    expect(adfs.mapAdfsClaims(baseConfig, {
      upn: "Alice@Example.test",
      email: "alice@example.test",
      name: "Alice Example",
    })).toEqual({
      username: "Alice@Example.test",
      email: "alice@example.test",
      fullName: "Alice Example",
    });
    expect(() => adfs.mapAdfsClaims(baseConfig, { name: "Anonymous" }))
      .toThrow(expect.objectContaining({ code: "account_not_found" }));
  });

  it("validates PEM certificates without exposing their contents", () => {
    expect(adfs.validatePemCertificate(rootCertificates[0]!)).toBe(true);
    expect(adfs.validatePemCertificate("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----")).toBe(false);
    expect(adfs.validatePemCertificate(`${rootCertificates[0]}\nnot-a-pem-object`)).toBe(false);
    expect(adfs.validatePemCertificate("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----")).toBe(false);
    expect(adfs.validateAdfsSettingsInput({ caCertPem: "not a certificate" })).toMatch(/valid PEM/i);
  });

  it("uses PKCE for public and confidential token exchanges without sending an empty secret", () => {
    const publicBody = adfs.tokenExchangeBody(baseConfig, "code", "verifier", "");
    expect(publicBody.get("code_verifier")).toBe("verifier");
    expect(publicBody.has("client_secret")).toBe(false);
    const confidentialBody = adfs.tokenExchangeBody(baseConfig, "code", "verifier", "configured-secret");
    expect(confidentialBody.get("client_secret")).toBe("configured-secret");
  });

  it("extends, rather than replaces, Node's trusted roots for a custom AD FS CA", () => {
    const customCa = "-----BEGIN CERTIFICATE-----\ncustom\n-----END CERTIFICATE-----";
    const rootsAndCustom = adfs.adfsCaCertificates(customCa);
    expect(rootsAndCustom).toContain(rootCertificates[0]);
    expect(rootsAndCustom).toContain(customCa);
  });
});

describe("AD FS existing-user resolution", () => {
  beforeEach(() => dbMock.reset());

  it("matches an existing enabled account case-insensitively", async () => {
    const user = { id: 7, username: "Alice@Example.test", email: "alice@example.test", isActive: true };
    dbMock.enqueue("select", [user]);
    await expect(adfs.resolveAdfsUser({ username: "alice@example.test", email: "ALICE@example.test" })).resolves.toBe(user);
  });

  it("rejects disabled users and identifier conflicts without provisioning", async () => {
    dbMock.enqueue("select", [{ id: 7, username: "alice", email: "a@example.test", isActive: false }]);
    await expect(adfs.resolveAdfsUser({ username: "alice", email: "a@example.test" }))
      .rejects.toMatchObject({ code: "account_disabled" });
    dbMock.enqueue("select", [
      { id: 7, username: "alice", email: "a@example.test", isActive: true },
      { id: 8, username: "other", email: "alice@example.test", isActive: true },
    ]);
    await expect(adfs.resolveAdfsUser({ username: "alice", email: "alice@example.test" }))
      .rejects.toMatchObject({ code: "identity_conflict" });
  });
});

describe("AD FS signed ID token verification", () => {
  const verify = (token: string, nonce = "expected-nonce", keys: unknown[] = [jwk]) =>
    adfs.verifyAdfsIdToken(baseConfig, baseConfig.issuer, token, nonce, keys);

  it("accepts a real RSA-signed ID token with issuer, audience, nonce, expiry, and sub", () => {
    expect(verify(signedIdToken())).toMatchObject({ sub: "stable-subject", nonce: "expected-nonce" });
  });

  it("rejects wrong issuer, audience, nonce, missing sub, expired/not-yet-valid time, and multi-audience azp", () => {
    expect(() => verify(signedIdToken({}, { issuer: "https://other.example/adfs" })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({}, { audience: "other-client" })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken(), "wrong-nonce"))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({ sub: "" })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({}, { expiresIn: -60 })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({}, { notBefore: 3600 })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({ azp: "wrong-client" }, { audience: [baseConfig.clientId, "another-audience"] })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({ azp: "wrong-client" })))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(verify(signedIdToken({ azp: baseConfig.clientId }))).toMatchObject({ azp: baseConfig.clientId });
  });

  it("rejects unknown kids and signatures that do not match the selected JWKS key", () => {
    expect(() => verify(signedIdToken({}, {}, signingKey.privateKey, "unknown-kid")))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
    expect(() => verify(signedIdToken({}, {}, otherSigningKey.privateKey)))
      .toThrow(expect.objectContaining({ code: "token_validation" }));
  });
});