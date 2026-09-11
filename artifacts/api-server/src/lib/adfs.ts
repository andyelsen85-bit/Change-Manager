import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import jwt, { type Algorithm } from "jsonwebtoken";
import { Agent, fetch } from "undici";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import {
  db,
  adfsAuthTransactionsTable,
  adfsSettingsTable,
  usersTable,
  type User,
} from "@workspace/db";
import { decryptSecret } from "./secret-crypto";

const KEY = "global";
const STATE_COOKIE = "cm_adfs_state";
const STATE_TTL_SECONDS = 10 * 60;
const DEFAULTS = {
  displayName: "Sign in with AD FS",
  scopes: "openid profile email",
  usernameClaim: "upn",
  emailClaim: "email",
  displayNameClaim: "name",
};

export type AdfsConfig = {
  enabled: boolean;
  displayName: string;
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecretEnc: string | null;
  redirectUri: string;
  scopes: string;
  usernameClaim: string;
  emailClaim: string;
  displayNameClaim: string;
  caCertPem: string | null;
};

export type AdfsPublicConfig = {
  enabled: boolean;
  configured: boolean;
  displayName: string;
};

export class AdfsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function envEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env["ADFS_ENABLED"] ?? "").toLowerCase());
}

function envConfig(): AdfsConfig {
  return {
    enabled: envEnabled(),
    displayName: process.env["ADFS_DISPLAY_NAME"]?.trim() || DEFAULTS.displayName,
    issuer: process.env["ADFS_ISSUER"]?.trim() || "",
    discoveryUrl: process.env["ADFS_DISCOVERY_URL"]?.trim() || "",
    clientId: process.env["ADFS_CLIENT_ID"]?.trim() || "",
    clientSecretEnc: process.env["ADFS_CLIENT_SECRET"] || null,
    redirectUri: process.env["ADFS_REDIRECT_URI"]?.trim() || "",
    scopes: normalizeScopes(process.env["ADFS_SCOPES"] || DEFAULTS.scopes),
    usernameClaim: process.env["ADFS_USERNAME_CLAIM"]?.trim() || DEFAULTS.usernameClaim,
    emailClaim: process.env["ADFS_EMAIL_CLAIM"]?.trim() || DEFAULTS.emailClaim,
    displayNameClaim: process.env["ADFS_DISPLAY_NAME_CLAIM"]?.trim() || DEFAULTS.displayNameClaim,
    caCertPem: process.env["ADFS_CA_CERT_PEM"]?.trim() || null,
  };
}

function rowConfig(row: typeof adfsSettingsTable.$inferSelect): AdfsConfig {
  return {
    enabled: row.enabled,
    displayName: row.displayName || DEFAULTS.displayName,
    issuer: row.issuer,
    discoveryUrl: row.discoveryUrl,
    clientId: row.clientId,
    clientSecretEnc: row.clientSecretEnc,
    redirectUri: row.redirectUri,
    scopes: normalizeScopes(row.scopes),
    usernameClaim: row.usernameClaim || DEFAULTS.usernameClaim,
    emailClaim: row.emailClaim || DEFAULTS.emailClaim,
    displayNameClaim: row.displayNameClaim || DEFAULTS.displayNameClaim,
    caCertPem: row.caCertPem,
  };
}

export async function getAdfsConfig(
  storedRow?: typeof adfsSettingsTable.$inferSelect | null,
): Promise<AdfsConfig> {
  if (storedRow !== undefined) return storedRow ? rowConfig(storedRow) : envConfig();
  const [row] = await db.select().from(adfsSettingsTable).where(eq(adfsSettingsTable.key, KEY));
  // A saved row is an explicit administrator decision, including an explicit
  // cleared secret/CA. It therefore takes precedence over all environment values.
  return row ? rowConfig(row) : envConfig();
}

export function normalizeScopes(value: string): string {
  const scopes = Array.from(new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean)));
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return scopes.join(" ");
}

export function isAdfsConfigured(config: AdfsConfig): boolean {
  return !!(
    config.enabled &&
    isHttpsUrl(config.issuer) &&
    config.clientId.trim() &&
    isAllowedRedirectUrl(config.redirectUri) &&
    config.usernameClaim.trim()
  );
}

export async function getAdfsPublicConfig(): Promise<AdfsPublicConfig> {
  const config = await getAdfsConfig();
  return {
    enabled: config.enabled,
    configured: isAdfsConfigured(config),
    displayName: config.displayName,
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAllowedRedirectUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  return process.env["NODE_ENV"] !== "production" || new URL(value).protocol === "https:";
}

export function validateAdfsSettingsInput(input: Record<string, unknown>): string | null {
  for (const field of ["issuer", "discoveryUrl"]) {
    const value = input[field];
    if (typeof value === "string" && value.trim() && !isHttpsUrl(value.trim())) {
      return `${field} must be an HTTPS URL`;
    }
  }
  if (typeof input["redirectUri"] === "string" && input["redirectUri"].trim() && !isAllowedRedirectUrl(input["redirectUri"].trim())) {
    return process.env["NODE_ENV"] === "production"
      ? "redirectUri must be an HTTPS URL in production"
      : "redirectUri must be an HTTP(S) URL";
  }
  for (const field of ["displayName", "clientId", "usernameClaim", "emailClaim", "displayNameClaim"]) {
    if (typeof input[field] === "string" && input[field].length > 512) return `${field} is too long`;
  }
  if (typeof input["scopes"] === "string" && input["scopes"].length > 1024) return "scopes is too long";
  if (input["clientSecret"] !== undefined && input["clientSecret"] !== null && typeof input["clientSecret"] !== "string") {
    return "clientSecret must be a string or null";
  }
  if (input["caCertPem"] !== undefined && input["caCertPem"] !== null) {
    if (typeof input["caCertPem"] !== "string" || !validatePemCertificate(input["caCertPem"])) {
      return "caCertPem must contain a valid PEM certificate";
    }
  }
  return null;
}

export function validatePemCertificate(pem: string): boolean {
  try {
    const trimmed = pem.trim();
    if (!trimmed || /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(trimmed)) return false;
    const blocks = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!blocks?.length) return false;
    // Do not silently accept just the first PEM object: a CA chain must be
    // entirely certificates, without private keys or arbitrary trailing data.
    if (trimmed.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) return false;
    for (const block of blocks) new X509Certificate(block);
    return true;
  } catch {
    return false;
  }
}

function stateSecret(): string {
  const encryptionKey = process.env["APP_ENCRYPTION_KEY"];
  if (encryptionKey && encryptionKey.length >= 16) return encryptionKey;
  const sessionKey = process.env["JWT_SECRET"];
  if (sessionKey && sessionKey.length >= 16) return sessionKey;
  // This matches the development-only session-secret posture. Production auth.ts
  // refuses to boot without JWT_SECRET, so production state never uses this value.
  return "dev-only-change-mgmt-secret-do-not-use-in-prod";
}

export type AdfsState = { state: string; nonce: string; verifier: string; returnTo: string };

export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > 4096) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded)
  ) {
    return "/";
  }
  return raw;
}

export function createAdfsState(returnTo: unknown): { state: AdfsState; signedCookie: string } {
  const state: AdfsState = {
    state: randomBytes(32).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    returnTo: sanitizeReturnTo(returnTo),
  };
  return {
    state,
    signedCookie: jwt.sign(state, stateSecret(), {
      expiresIn: STATE_TTL_SECONDS,
      audience: "cm-adfs-state",
      issuer: "change-mgmt",
    }),
  };
}

export function readAdfsState(signedCookie: unknown): AdfsState | null {
  if (typeof signedCookie !== "string") return null;
  try {
    const decoded = jwt.verify(signedCookie, stateSecret(), {
      audience: "cm-adfs-state",
      issuer: "change-mgmt",
    }) as jwt.JwtPayload;
    if (
      typeof decoded.state !== "string" ||
      typeof decoded.nonce !== "string" ||
      typeof decoded.verifier !== "string" ||
      typeof decoded.returnTo !== "string"
    ) {
      return null;
    }
    return {
      state: decoded.state,
      nonce: decoded.nonce,
      verifier: decoded.verifier,
      returnTo: sanitizeReturnTo(decoded.returnTo),
    };
  } catch {
    return null;
  }
}

export function stateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function hashAdfsState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

// Settings affecting either where a code is redeemed or how its ID token is
// interpreted are part of the transaction fingerprint. A settings change
// invalidates outstanding browser state instead of applying new policy to an
// old authorization response.
export function adfsConfigFingerprint(config: AdfsConfig): string {
  const secret = decryptSecret(config.clientSecretEnc);
  const source = JSON.stringify({
    issuer: config.issuer,
    discoveryUrl: config.discoveryUrl,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: normalizeScopes(config.scopes),
    usernameClaim: config.usernameClaim,
    emailClaim: config.emailClaim,
    displayNameClaim: config.displayNameClaim,
    caCertPem: config.caCertPem ?? "",
    clientSecret: secret,
  });
  // A plain digest containing a secret-derived component is an offline
  // verifier if this database value leaks. Bind the fingerprint to a server
  // secret instead; it is only an equality token, never a credential hash.
  return createHmac("sha256", stateSecret()).update(source).digest("base64url");
}

export async function createAdfsStateTransaction(state: string, config: AdfsConfig): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    // Expired attempts were never redeemed, so remove them opportunistically
    // before adding a new one. Redeemed rows are deleted by consume below.
    await tx.delete(adfsAuthTransactionsTable).where(lt(adfsAuthTransactionsTable.expiresAt, now));
    await tx.insert(adfsAuthTransactionsTable).values({
    stateHash: hashAdfsState(state),
      configFingerprint: adfsConfigFingerprint(config),
      expiresAt: new Date(now.getTime() + STATE_TTL_SECONDS * 1000),
      consumedAt: null,
    });
  });
}

// The conditional delete is atomic in PostgreSQL. Wrapping it in the database
// transaction API makes this intent explicit and works across API processes,
// unlike an in-memory replay map.
export async function consumeAdfsState(state: string, config: AdfsConfig): Promise<boolean> {
  const now = new Date();
  const hash = hashAdfsState(state);
  const fingerprint = adfsConfigFingerprint(config);
  return db.transaction(async (tx) => {
    const consumed = await tx
      .delete(adfsAuthTransactionsTable)
      .where(and(
        eq(adfsAuthTransactionsTable.stateHash, hash),
        eq(adfsAuthTransactionsTable.configFingerprint, fingerprint),
        gt(adfsAuthTransactionsTable.expiresAt, now),
      ))
      .returning({ stateHash: adfsAuthTransactionsTable.stateHash });
    return consumed.length === 1;
  });
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function adfsCaCertificates(caCertPem: string | null): string[] {
  let defaults: readonly string[];
  try {
    defaults = typeof tls.getCACertificates === "function"
      ? tls.getCACertificates("default")
      : tls.rootCertificates;
  } catch {
    defaults = tls.rootCertificates;
  }
  return caCertPem ? [...defaults, caCertPem] : [...defaults];
}

function adfsDispatcher(config: AdfsConfig): Agent | undefined {
  if (!config.caCertPem) return undefined;
  // Supplying the complete system root set is important: Node treats `ca` as
  // a replacement otherwise. This allows an internal AD FS CA without breaking
  // trust for public endpoints.
  return new Agent({ connect: { ca: adfsCaCertificates(config.caCertPem) } });
}

async function responseJson(response: Response, code: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new AdfsError(code);
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AdfsError(code);
  }
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type Jwk = {
  kid?: string;
  use?: string;
  kty?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
};

function readDiscovery(value: Record<string, unknown>, config: AdfsConfig): Discovery {
  const issuer = typeof value.issuer === "string" ? value.issuer : "";
  const authorization_endpoint = typeof value.authorization_endpoint === "string" ? value.authorization_endpoint : "";
  const token_endpoint = typeof value.token_endpoint === "string" ? value.token_endpoint : "";
  const jwks_uri = typeof value.jwks_uri === "string" ? value.jwks_uri : "";
  if (
    !isHttpsUrl(issuer) ||
    !isHttpsUrl(authorization_endpoint) ||
    !isHttpsUrl(token_endpoint) ||
    !isHttpsUrl(jwks_uri) ||
    issuer !== config.issuer
  ) {
    throw new AdfsError("configuration");
  }
  return { issuer, authorization_endpoint, token_endpoint, jwks_uri };
}

async function withDispatcher<T>(config: AdfsConfig, action: (dispatcher?: Agent) => Promise<T>): Promise<T> {
  const dispatcher = adfsDispatcher(config);
  try {
    return await action(dispatcher);
  } finally {
    await dispatcher?.close();
  }
}

async function getDiscovery(config: AdfsConfig): Promise<Discovery> {
  const discoveryUrl = config.discoveryUrl || `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  if (!isHttpsUrl(discoveryUrl)) throw new AdfsError("configuration");
  return withDispatcher(config, async (dispatcher) => {
    const response = await fetch(discoveryUrl, { dispatcher, redirect: "error" });
    return readDiscovery(await responseJson(response, "configuration"), config);
  });
}

export async function authorizationUrl(config: AdfsConfig, state: AdfsState): Promise<string> {
  const discovery = await getDiscovery(config);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", normalizeScopes(config.scopes));
  url.searchParams.set("state", state.state);
  url.searchParams.set("nonce", state.nonce);
  url.searchParams.set("code_challenge", pkceChallenge(state.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function tokenExchangeBody(config: AdfsConfig, code: string, verifier: string, clientSecret: string): URLSearchParams {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  if (clientSecret) params.set("client_secret", clientSecret);
  return params;
}

async function exchangeCode(config: AdfsConfig, discovery: Discovery, code: string, verifier: string): Promise<string> {
  const params = tokenExchangeBody(config, code, verifier, decryptSecret(config.clientSecretEnc));
  return withDispatcher(config, async (dispatcher) => {
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      dispatcher,
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: params.toString(),
    });
    const body = await responseJson(response, "token_exchange");
    if (typeof body.id_token !== "string" || !body.id_token) throw new AdfsError("token_exchange");
    return body.id_token;
  });
}

export function verifyAdfsIdToken(
  config: AdfsConfig,
  issuer: string,
  idToken: string,
  nonce: string,
  keys: unknown[],
): Record<string, unknown> {
  const complete = jwt.decode(idToken, { complete: true });
  if (!complete || typeof complete === "string" || !complete.header.kid || typeof complete.header.alg !== "string") {
    throw new AdfsError("token_validation");
  }
  const allowedAlgorithms: Algorithm[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"];
  if (!allowedAlgorithms.includes(complete.header.alg as Algorithm)) throw new AdfsError("token_validation");
  const jwk = keys.find((candidate): candidate is Jwk =>
    !!candidate && typeof candidate === "object" &&
    (candidate as Jwk).kid === complete.header.kid &&
    (candidate as Jwk).use !== "enc",
  );
  if (!jwk) throw new AdfsError("token_validation");
  let key;
  try {
    key = createPublicKey({ key: jwk as never, format: "jwk" });
  } catch {
    throw new AdfsError("token_validation");
  }
  try {
    const claims = jwt.verify(idToken, key, {
      algorithms: allowedAlgorithms,
      issuer,
      audience: config.clientId,
      clockTolerance: 30,
    }) as jwt.JwtPayload;
    // jsonwebtoken enforces exp and nbf when present. Require exp rather than
    // accepting an otherwise-valid bearer assertion that never expires, and
    // reject a materially future-issued token as token substitution defense.
    if (
      typeof claims.exp !== "number" ||
      (typeof claims.iat === "number" && claims.iat > Math.floor(Date.now() / 1000) + 30) ||
      claims.nonce !== nonce ||
      typeof claims.sub !== "string" ||
      !claims.sub.trim() ||
      (claims.azp !== undefined && claims.azp !== config.clientId) ||
      (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId)
    ) {
      throw new Error("invalid token timing or nonce");
    }
    return claims as Record<string, unknown>;
  } catch {
    throw new AdfsError("token_validation");
  }
}

async function validateIdToken(config: AdfsConfig, discovery: Discovery, idToken: string, nonce: string): Promise<Record<string, unknown>> {
  return withDispatcher(config, async (dispatcher) => {
    const response = await fetch(discovery.jwks_uri, { dispatcher, redirect: "error" });
    const body = await responseJson(response, "token_validation");
    return verifyAdfsIdToken(config, discovery.issuer, idToken, nonce, Array.isArray(body.keys) ? body.keys : []);
  });
}

export function mapAdfsClaims(config: AdfsConfig, claims: Record<string, unknown>): {
  username: string;
  email: string;
  fullName: string;
} {
  const claim = (name: string): string => typeof claims[name] === "string" ? claims[name].trim() : "";
  const username = claim(config.usernameClaim);
  const email = claim(config.emailClaim);
  const fullName = claim(config.displayNameClaim) || username || email;
  if (!username && !email) throw new AdfsError("account_not_found");
  return { username, email, fullName };
}

export async function resolveAdfsUser(identity: { username: string; email: string }): Promise<User> {
  const username = identity.username.trim().toLocaleLowerCase();
  const email = identity.email.trim().toLocaleLowerCase();
  const conditions = [];
  if (username) conditions.push(sql`lower(${usersTable.username}) = ${username}`);
  if (email) conditions.push(sql`lower(${usersTable.email}) = ${email}`);
  if (!conditions.length) throw new AdfsError("account_not_found");
  const matches = await db.select().from(usersTable).where(or(...conditions));
  if (matches.length === 0) throw new AdfsError("account_not_found");
  // Matching username and email to different accounts is never silently merged.
  if (matches.length !== 1) throw new AdfsError("identity_conflict");
  if (!matches[0]!.isActive) throw new AdfsError("account_disabled");
  return matches[0]!;
}

export async function completeAdfsLogin(code: string, state: AdfsState, savedConfig?: AdfsConfig): Promise<User> {
  const config = savedConfig ?? await getAdfsConfig();
  if (!isAdfsConfigured(config)) throw new AdfsError("configuration");
  const discovery = await getDiscovery(config);
  const idToken = await exchangeCode(config, discovery, code, state.verifier);
  const claims = await validateIdToken(config, discovery, idToken, state.nonce);
  return resolveAdfsUser(mapAdfsClaims(config, claims));
}

export const adfsStateCookieName = STATE_COOKIE;
export const adfsStateTtlMs = STATE_TTL_SECONDS * 1000;