import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, ssoSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptSecret } from "./secret-crypto";

// Lazy-loaded handle to the native `kerberos` module. Held in a module-level
// variable so we only pay the dlopen cost once. Wrapped in an
// always-resolved promise so concurrent callers all wait for the same
// import attempt instead of racing.
type KerberosModule = {
  initializeServer?: (
    spn: string,
  ) => Promise<{
    step: (clientToken: string) => Promise<string>;
    username?: string;
    targetName?: string;
    response?: string;
  }>;
  // Older releases exposed initializeServer via a callback-only API; we
  // detect both shapes at runtime.
  default?: KerberosModule;
};
let kerberosModulePromise: Promise<KerberosModule | null> | null = null;
function loadKerberos(): Promise<KerberosModule | null> {
  if (kerberosModulePromise) return kerberosModulePromise;
  kerberosModulePromise = (async () => {
    try {
      // The `kerberos` package is an OPTIONAL dependency — in dev or in
      // images that don't ship libkrb5, the require fails. We swallow
      // the error here so the rest of the app still boots; callers see
      // a `kerberos_unavailable` failure instead of a crash.
      // `kerberos` is an optional native dep — there are no @types for it
      // and it may not be installed at all. We deliberately import it via
      // a string variable so TypeScript doesn't try to resolve the module
      // at compile time, then cast through unknown to our local shape.
      const modName = "kerberos";
      const mod = (await import(/* @vite-ignore */ modName)) as unknown as KerberosModule & { default?: KerberosModule };
      return mod?.default ?? mod;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "kerberos native module not available; SPNEGO SSO disabled",
      );
      return null;
    }
  })();
  return kerberosModulePromise;
}

export async function getSso() {
  const [row] = await db.select().from(ssoSettingsTable).where(eq(ssoSettingsTable.key, "global"));
  return row ?? null;
}

// Materialise the keytab and (optional) krb5.conf onto disk, then point the
// MIT Kerberos environment variables at them. We do this on demand instead
// of at server startup so that re-uploading the keytab via the admin UI is
// picked up without restarting the API container — the next SSO request
// will re-read the row, re-write the file, and the GSSAPI library reads
// the file fresh on every `accept_sec_context` call.
//
// Files live under a per-process tmp directory (mode 0700, file mode 0600)
// so the keytab — which is functionally a long-term secret — is not
// readable by other users on the host.
const SECRET_DIR = join(tmpdir(), "cm-sso");
const KEYTAB_PATH = join(SECRET_DIR, "service.keytab");
const KRB5_CONF_PATH = join(SECRET_DIR, "krb5.conf");

let lastInstalled: { keytab?: string; krb5?: string } = {};

function installSecrets(keytabB64: string | null, krb5Conf: string): void {
  if (!existsSync(SECRET_DIR)) {
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  }
  if (keytabB64 && keytabB64 !== lastInstalled.keytab) {
    // Stored keytab is encrypted at rest with secret-crypto's AES-GCM;
    // decrypt to the raw base64 string before decoding to bytes. Legacy
    // plaintext rows (no `enc:v1:` prefix) flow through unchanged.
    const rawB64 = decryptSecret(keytabB64);
    const buf = Buffer.from(rawB64, "base64");
    writeFileSync(KEYTAB_PATH, buf, { mode: 0o600 });
    process.env["KRB5_KTNAME"] = `FILE:${KEYTAB_PATH}`;
    lastInstalled.keytab = keytabB64;
  }
  if (krb5Conf && krb5Conf !== lastInstalled.krb5) {
    writeFileSync(KRB5_CONF_PATH, krb5Conf, { mode: 0o600 });
    process.env["KRB5_CONFIG"] = KRB5_CONF_PATH;
    lastInstalled.krb5 = krb5Conf;
  }
}

export type SpnegoStage =
  | "config"        // settings missing or feature disabled
  | "module"        // native kerberos module not loaded
  | "no-token"      // first leg of the handshake; client must retry
  | "accept"        // accept_sec_context failed (bad ticket, clock skew, ...)
  | "ok";

export type SpnegoResult =
  | {
      ok: true;
      stage: "ok";
      principal: string;        // e.g. alice@CORP.LOCAL
      username: string;         // post-stripRealm
      // When the GSSAPI exchange needs another round-trip the server
      // includes a continuation token here that the client echoes back
      // in the next Authorization header. For single-leg SPNEGO this
      // is undefined.
      continuationToken?: string;
    }
  | {
      ok: false;
      stage: SpnegoStage;
      reason: string;
      wwwAuthenticate?: string; // value to send in 401 response
      details?: string;
    };

// Drive one round of the SPNEGO handshake. The caller passes the raw value
// of the `Authorization` header (or null on the first leg). We return one
// of three outcomes:
//   - first leg / no token        → 401 + WWW-Authenticate: Negotiate
//   - handshake completed         → ok=true with the authenticated principal
//   - handshake failed (bad ticket, clock skew, missing keytab, ...)
//                                 → ok=false with a diagnostic stage/reason
export async function acceptSpnego(authHeader: string | null | undefined): Promise<SpnegoResult> {
  const cfg = await getSso();
  if (!cfg || !cfg.enabled) {
    return { ok: false, stage: "config", reason: "SSO is not enabled" };
  }
  if (!cfg.servicePrincipal) {
    return {
      ok: false,
      stage: "config",
      reason:
        "SSO has no Service Principal configured. Set it under Settings → SSO " +
        "(e.g. HTTP/host.corp.local@CORP.LOCAL) before enabling.",
    };
  }
  if (!cfg.keytabB64) {
    return {
      ok: false,
      stage: "config",
      reason:
        "SSO has no keytab uploaded. Generate one on the AD side with ktpass " +
        "and upload it under Settings → SSO before enabling.",
    };
  }

  installSecrets(cfg.keytabB64, cfg.krb5Conf);

  const kerberos = await loadKerberos();
  if (!kerberos || typeof kerberos.initializeServer !== "function") {
    return {
      ok: false,
      stage: "module",
      reason:
        "The Kerberos native module is not loaded on this server. Rebuild the " +
        "API container with libkrb5 / krb5-libs installed and `npm install " +
        "kerberos --build-from-source`.",
    };
  }

  // First leg: no Authorization header at all → ask the browser to do SPNEGO.
  // Browsers that have the site in their Trusted/Intranet zone will respond
  // with `Authorization: Negotiate <base64>` on the retry.
  if (!authHeader || !authHeader.toLowerCase().startsWith("negotiate ")) {
    return {
      ok: false,
      stage: "no-token",
      reason: "Negotiate token required",
      wwwAuthenticate: "Negotiate",
    };
  }
  const clientToken = authHeader.slice("negotiate ".length).trim();
  if (!clientToken) {
    return {
      ok: false,
      stage: "no-token",
      reason: "Empty Negotiate token",
      wwwAuthenticate: "Negotiate",
    };
  }

  try {
    const ctx = await kerberos.initializeServer(cfg.servicePrincipal);
    const continuation = await ctx.step(clientToken);
    const principal = ctx.username || "";
    if (!principal) {
      // The handshake produced a continuation token but no principal yet —
      // tell the client to retry with the new token. In practice, modern
      // browsers and modern AD complete in one round so this is rare.
      return {
        ok: false,
        stage: "no-token",
        reason: "Handshake requires another round-trip",
        wwwAuthenticate: continuation ? `Negotiate ${continuation}` : "Negotiate",
      };
    }
    const username = cfg.stripRealm ? principal.split("@")[0]! : principal;
    logger.info({ principal, username }, "SPNEGO handshake ok");
    return {
      ok: true,
      stage: "ok",
      principal,
      username,
      continuationToken: continuation || undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, spn: cfg.servicePrincipal }, "SPNEGO accept_sec_context failed");
    return {
      ok: false,
      stage: "accept",
      reason: "Kerberos handshake rejected the client ticket",
      details: msg,
    };
  }
}

// Reset the cached `loadKerberos` promise — exposed for tests so they can
// inject a fake module via `vi.mock("kerberos", ...)` without leaking
// across test cases.
export function _resetKerberosModuleForTests(): void {
  kerberosModulePromise = null;
  lastInstalled = {};
}
