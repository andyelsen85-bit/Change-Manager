import { eq } from "drizzle-orm";
import { db, ldapSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { decryptSecret } from "./secret-crypto";

export async function getLdap() {
  const [row] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.key, "global"));
  return row ?? null;
}

// The phase of the LDAP exchange. Surfacing this lets the UI tell admins
// exactly where the bind broke (vs. a generic "auth failed").
export type LdapStage =
  | "config"        // settings missing / disabled
  | "connect"       // TCP / TLS to the LDAP server
  | "service-bind"  // binding as the service account
  | "search"        // looking up the user under baseDn
  | "user-bind"     // binding as the resolved user
  | "ok";

export type LdapAuthResult =
  | {
      ok: true;
      stage: "ok";
      username: string;
      email: string;
      fullName: string;
      userDn: string;
    }
  | {
      ok: false;
      stage: LdapStage;
      reason: string;
      code?: string;
      details?: string;
    };

// ldapjs throws Error instances enriched with a numeric `.code`, an LDAP
// result-code name (e.g. "InvalidCredentialsError"), and often a server-side
// `.lde_message` describing what AD or OpenLDAP actually rejected. We collect
// all three when possible. For socket-level errors (DNS / refused / TLS) we
// fall back to the Node error code (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / ...).
function extractLdapError(err: unknown): { code?: string; details?: string } {
  if (!err || typeof err !== "object") return {};
  const e = err as {
    name?: string;
    code?: string | number;
    lde_message?: string;
    message?: string;
  };
  const codeName =
    typeof e.name === "string" && e.name.endsWith("Error") ? e.name : undefined;
  const codeNum = typeof e.code === "number" || typeof e.code === "string" ? String(e.code) : undefined;
  const code = codeName ?? codeNum;
  const details = (e.lde_message && String(e.lde_message)) || (e.message && String(e.message)) || undefined;
  return { code, details };
}

// Escape a value for safe interpolation into an LDAP search filter, per
// RFC 4515 §3. Without this, a login like `*)(uid=*` injected into a
// filter such as `(uid={{username}})` would broaden the search to any
// account in the directory. Escaping turns the special characters into
// their hex form so the directory treats them as literal characters.
function escapeLdapFilter(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x00: out += "\\00"; break; // NUL
      case 0x28: out += "\\28"; break; // (
      case 0x29: out += "\\29"; break; // )
      case 0x2a: out += "\\2a"; break; // *
      case 0x5c: out += "\\5c"; break; // \
      default:   out += s[i];
    }
  }
  return out;
}

// Mask the username to a short fingerprint when including it in logs that
// might be archived. Keeps just first char + length so an operator can still
// correlate "j_____(4)" with the test they ran without leaking full UPNs.
function maskName(s: string): string {
  if (!s) return "";
  if (s.length <= 2) return `${s[0] ?? ""}_(${s.length})`;
  return `${s[0]}${"_".repeat(Math.min(4, s.length - 2))}(${s.length})`;
}

// Parse an ldapjs SearchEntry into a flat string-valued record. ldapjs has
// shipped three different entry shapes over its lifetime (`pojo`, `object`,
// and a raw `attributes[]` array on older releases), so we try each in order.
// All keys are returned in their original casing — call sites use pickAttr()
// for case-insensitive lookups.
function parseLdapEntry(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const ee = e as { pojo?: Record<string, unknown>; object?: Record<string, unknown>; attributes?: Array<{ type?: string; values?: unknown[]; vals?: unknown[] }> };
  const obj = ee.pojo ?? ee.object;
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "type" || k === "controls" || k === "objectName" || k === "dn") continue;
      if (Array.isArray(v)) { if (v.length) out[k] = String(v[0] ?? ""); }
      else if (typeof v === "string") out[k] = v;
      else if (v != null) out[k] = String(v);
    }
  }
  if (Array.isArray(ee.attributes)) {
    for (const a of ee.attributes) {
      const key = a?.type;
      if (!key) continue;
      const vals = (a.values ?? a.vals) as unknown[] | undefined;
      if (Array.isArray(vals) && vals.length && out[key] == null) {
        out[key] = String(vals[0] ?? "");
      }
    }
  }
  return out;
}

function extractEntryDn(e: unknown): string {
  const ee = e as { objectName?: string; dn?: string | { toString?: () => string }; pojo?: { objectName?: string; dn?: string } };
  if (typeof ee.objectName === "string" && ee.objectName) return ee.objectName;
  if (typeof ee.dn === "string" && ee.dn) return ee.dn;
  if (ee.dn && typeof (ee.dn as { toString?: () => string }).toString === "function") {
    const s = (ee.dn as { toString: () => string }).toString();
    if (s && s !== "[object Object]") return s;
  }
  if (ee.pojo) return ee.pojo.objectName ?? ee.pojo.dn ?? "";
  return "";
}

// Case-insensitive attribute lookup. Returns the first non-empty value among
// the supplied keys, matching keys without regard to case. Empty strings are
// treated as "missing" so `mail=""` doesn't shadow a populated fallback.
function pickAttr(entry: Record<string, string>, keys: string[]): string {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    if (!k) continue;
    const v = lower[k.toLowerCase()];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

// Look up an LDAP user by username WITHOUT verifying their password. Used by
// the admin "create LDAP user" flow to pull displayName / mail straight from
// the directory so the operator only has to type the short login. Returns
// the same shaped result as authenticateLdap but never reaches `user-bind`.
export type LdapLookupResult =
  | { ok: true; username: string; email: string; fullName: string; userDn: string }
  | { ok: false; stage: LdapStage; reason: string; code?: string; details?: string };

export async function lookupLdapUser(username: string): Promise<LdapLookupResult> {
  const cfg = await getLdap();
  if (!cfg || !cfg.enabled) {
    return { ok: false, stage: "config", reason: "LDAP disabled" };
  }
  if (!cfg.url || !cfg.baseDn) {
    return { ok: false, stage: "config", reason: "LDAP not configured (URL and Base DN required)" };
  }
  let ldap: typeof import("ldapjs");
  try {
    ldap = await import("ldapjs");
  } catch {
    return { ok: false, stage: "config", reason: "LDAP library missing" };
  }
  return new Promise<LdapLookupResult>((resolve) => {
    const rejectUnauthorized = cfg.tlsRejectUnauthorized !== false;
    const isLdaps = cfg.url.toLowerCase().startsWith("ldaps:");
    const tlsOptions = (isLdaps || cfg.tls) ? { rejectUnauthorized } : undefined;
    let client: import("ldapjs").Client;
    try {
      client = ldap.createClient({ url: cfg.url, tlsOptions, timeout: 5000, connectTimeout: 5000 });
    } catch (err) {
      const { code, details } = extractLdapError(err);
      return resolve({ ok: false, stage: "connect", reason: "Could not initialise LDAP client", code, details });
    }
    let resolved = false;
    const finish = (r: LdapLookupResult) => {
      if (resolved) return;
      resolved = true;
      try { client.unbind(); } catch { /* ignore */ }
      const ctx = { url: cfg.url, baseDn: cfg.baseDn, usernameMasked: maskName(username), ok: r.ok };
      if (r.ok) logger.info(ctx, "LDAP lookup ok");
      else logger.warn({ ...ctx, stage: r.stage, reason: r.reason, code: r.code }, "LDAP lookup failed");
      resolve(r);
    };
    client.on("error", (err) => {
      const { code, details } = extractLdapError(err);
      finish({ ok: false, stage: "connect", reason: "Could not reach LDAP server", code, details });
    });
    const doSearch = () => {
      const filter = cfg.userFilter.replace(/{{username}}/g, escapeLdapFilter(username));
      // Request the configured attributes plus common AD aliases so that even
      // if the admin typed "displayName" but the directory returns it under
      // "displayname" (case differs across server versions) we still get it.
      const wanted = Array.from(new Set([
        cfg.usernameAttr, cfg.emailAttr, cfg.nameAttr,
        "displayName", "cn", "name", "givenName", "sn",
        "mail", "userPrincipalName", "sAMAccountName", "uid",
      ]));
      const opts = { filter, scope: "sub" as const, attributes: wanted };
      client.search(cfg.baseDn, opts, (searchErr, searchRes) => {
        if (searchErr) {
          const { code, details } = extractLdapError(searchErr);
          return finish({ ok: false, stage: "search", reason: "LDAP search failed", code, details });
        }
        let entry: Record<string, string> | null = null;
        let entryDn = "";
        searchRes.on("searchEntry", (e: unknown) => {
          entry = parseLdapEntry(e);
          entryDn = extractEntryDn(e);
        });
        searchRes.on("error", (e) => {
          const { code, details } = extractLdapError(e);
          finish({ ok: false, stage: "search", reason: "LDAP search returned an error", code, details });
        });
        searchRes.on("end", () => {
          if (!entry || !entryDn) {
            return finish({
              ok: false,
              stage: "search",
              reason: "User not found — your User filter matched zero entries under the Base DN",
              details: `filter=${filter}, baseDn=${cfg.baseDn}`,
            });
          }
          const e = entry as Record<string, string>;
          // Diagnostic: log every attribute we got back so admins can see what
          // their directory actually returned vs. what we mapped onto fullName.
          logger.info(
            { usernameMasked: maskName(username), entryDn, attrs: Object.keys(e), nameAttr: cfg.nameAttr, emailAttr: cfg.emailAttr },
            "LDAP lookup entry attributes"
          );
          // Case-insensitive lookup with sensible AD fallbacks. Some servers
          // lowercase keys (`displayname`), some keep them as advertised
          // (`displayName`); we accept either, then fall back across the
          // commonly-populated alternatives before giving up.
          const fullName = pickAttr(e, [cfg.nameAttr, "displayName", "cn", "name"])
            || `${pickAttr(e, ["givenName"])} ${pickAttr(e, ["sn"])}`.trim()
            || username;
          const email = pickAttr(e, [cfg.emailAttr, "mail", "userPrincipalName"]) || `${username}@ldap.local`;
          const uname = pickAttr(e, [cfg.usernameAttr, "sAMAccountName", "uid"]) || username;
          finish({ ok: true, username: uname, email, fullName, userDn: entryDn });
        });
      });
    };
    if (cfg.bindDn && cfg.bindPasswordEnc) {
      const bindPassword = decryptSecret(cfg.bindPasswordEnc);
      client.bind(cfg.bindDn, bindPassword, (err) => {
        if (err) {
          const { code, details } = extractLdapError(err);
          return finish({ ok: false, stage: "service-bind", reason: "Service bind failed", code, details });
        }
        doSearch();
      });
    } else {
      doSearch();
    }
  });
}

// LDAP authenticate: bind as service account, search user, bind as user.
// We import ldapjs lazily so projects without LDAP configured don't pay the load cost.
export async function authenticateLdap(username: string, password: string): Promise<LdapAuthResult> {
  const cfg = await getLdap();
  if (!cfg || !cfg.enabled) {
    return { ok: false, stage: "config", reason: "LDAP disabled" };
  }
  if (!cfg.url || !cfg.baseDn) {
    return { ok: false, stage: "config", reason: "LDAP not configured (URL and Base DN required)" };
  }

  let ldap: typeof import("ldapjs");
  try {
    ldap = await import("ldapjs");
  } catch (err) {
    logger.error({ err }, "ldapjs not available");
    return { ok: false, stage: "config", reason: "LDAP library missing" };
  }

  return new Promise<LdapAuthResult>((resolve) => {
    // tlsRejectUnauthorized=false makes the TLS handshake accept any server
    // certificate (self-signed, expired, name mismatch). Default is true (verify).
    // Honoured for both ldaps:// (URL-driven TLS) and ldap:// + StartTLS.
    const rejectUnauthorized = cfg.tlsRejectUnauthorized !== false;
    const isLdaps = cfg.url.toLowerCase().startsWith("ldaps:");
    const tlsOptions = (isLdaps || cfg.tls) ? { rejectUnauthorized } : undefined;

    let client: import("ldapjs").Client;
    try {
      client = ldap.createClient({
        url: cfg.url,
        tlsOptions,
        timeout: 5000,
        connectTimeout: 5000,
      });
    } catch (err) {
      const { code, details } = extractLdapError(err);
      logger.warn({ err, url: cfg.url, code }, "LDAP createClient failed");
      resolve({ ok: false, stage: "connect", reason: "Could not initialise LDAP client", code, details });
      return;
    }

    let resolved = false;
    let stage: LdapStage = "connect";
    const finish = (r: LdapAuthResult) => {
      if (resolved) return;
      resolved = true;
      try {
        client.unbind();
      } catch {
        // ignore
      }
      const logCtx = {
        url: cfg.url,
        baseDn: cfg.baseDn,
        usernameMasked: maskName(username),
        stage: r.stage,
        ok: r.ok,
        code: r.ok ? undefined : r.code,
      };
      if (r.ok) logger.info(logCtx, "LDAP auth ok");
      else logger.warn({ ...logCtx, details: r.details, reason: r.reason }, "LDAP auth failed");
      resolve(r);
    };

    client.on("error", (err) => {
      const { code, details } = extractLdapError(err);
      logger.warn({ err, url: cfg.url, stage, code }, "LDAP connection error");
      finish({
        ok: false,
        stage: "connect",
        reason: "Could not reach LDAP server",
        code,
        details,
      });
    });

    const bindAsService = (cb: (err: Error | null) => void) => {
      stage = "service-bind";
      if (cfg.bindDn && cfg.bindPasswordEnc) {
        const bindPassword = decryptSecret(cfg.bindPasswordEnc);
        client.bind(cfg.bindDn, bindPassword, (err) => cb(err));
      } else {
        // Anonymous bind path — some directories permit search without a service account.
        cb(null);
      }
    };

    bindAsService((err) => {
      if (err) {
        const { code, details } = extractLdapError(err);
        finish({
          ok: false,
          stage: "service-bind",
          reason: cfg.bindDn
            ? "Service bind failed — check Bind DN and Bind password"
            : "Anonymous bind rejected — your directory likely requires a service account",
          code,
          details,
        });
        return;
      }
      stage = "search";
      // Render the search filter with the supplied username. The username is
      // escaped per RFC 4515 to neutralise injection attempts like
      // `*)(uid=*` — without this, a hostile login could broaden the search.
      // If the admin has not included the {{username}} token (a common
      // copy/paste mistake) the filter is sent as-is and will usually return
      // zero hits — which is exactly what we want to report.
      const filter = cfg.userFilter.replace(/{{username}}/g, escapeLdapFilter(username));
      const wanted = Array.from(new Set([
        cfg.usernameAttr, cfg.emailAttr, cfg.nameAttr,
        "displayName", "cn", "name", "givenName", "sn",
        "mail", "userPrincipalName", "sAMAccountName", "uid",
      ]));
      const opts = { filter, scope: "sub" as const, attributes: wanted };
      logger.debug({ baseDn: cfg.baseDn, filter, attrs: opts.attributes }, "LDAP search");
      client.search(cfg.baseDn, opts, (searchErr, searchRes) => {
        if (searchErr) {
          const { code, details } = extractLdapError(searchErr);
          finish({
            ok: false,
            stage: "search",
            reason: "LDAP search failed — check Base DN and User filter",
            code,
            details,
          });
          return;
        }
        let entry: Record<string, string> | null = null;
        let entryDn = "";
        searchRes.on("searchEntry", (e: unknown) => {
          entry = parseLdapEntry(e);
          entryDn = extractEntryDn(e);
        });
        searchRes.on("error", (e) => {
          const { code, details } = extractLdapError(e);
          finish({
            ok: false,
            stage: "search",
            reason: "LDAP search returned an error",
            code,
            details,
          });
        });
        searchRes.on("end", () => {
          if (!entry || !entryDn) {
            finish({
              ok: false,
              stage: "search",
              reason: "User not found — your User filter matched zero entries under the Base DN",
              details: `filter=${filter}, baseDn=${cfg.baseDn}`,
            });
            return;
          }
          stage = "user-bind";
          const userClient = ldap.createClient({
            url: cfg.url,
            // Mirror the same TLS options as the service-bind client so an
            // ldaps:// URL with the StartTLS toggle off still applies the
            // verify-cert policy on the user-bind handshake.
            tlsOptions,
            timeout: 5000,
            connectTimeout: 5000,
          });
          userClient.on("error", (e) => {
            const { code, details } = extractLdapError(e);
            finish({
              ok: false,
              stage: "user-bind",
              reason: "Lost connection while binding as the user",
              code,
              details,
            });
          });
          userClient.bind(entryDn, password, (bindErr) => {
            try {
              userClient.unbind();
            } catch {
              // ignore
            }
            if (bindErr) {
              const { code, details } = extractLdapError(bindErr);
              finish({
                ok: false,
                stage: "user-bind",
                reason: "Invalid credentials — username found, but password rejected",
                code,
                details,
              });
              return;
            }
            const e = entry!;
            const fullName = pickAttr(e, [cfg.nameAttr, "displayName", "cn", "name"])
              || `${pickAttr(e, ["givenName"])} ${pickAttr(e, ["sn"])}`.trim()
              || username;
            const email = pickAttr(e, [cfg.emailAttr, "mail", "userPrincipalName"]) || `${username}@ldap.local`;
            const uname = pickAttr(e, [cfg.usernameAttr, "sAMAccountName", "uid"]) || username;
            finish({
              ok: true,
              stage: "ok",
              username: uname,
              email,
              fullName,
              userDn: entryDn,
            });
          });
        });
      });
    });
  });
}

// Test-bind result that mirrors the diagnostic shape but is friendlier to
// surface in the admin UI. Keeps the legacy `success`/`message` fields so
// older clients (and the existing OpenAPI TestResult shape) keep working.
export type LdapTestResult = {
  success: boolean;
  stage: LdapStage;
  message: string;
  code?: string;
  details?: string;
  userDn?: string;
};

export async function testLdapConnection(username: string, password: string): Promise<LdapTestResult> {
  const r = await authenticateLdap(username, password);
  if (r.ok) {
    return {
      success: true,
      stage: "ok",
      message: `Bound as ${r.username} (${r.email})`,
      userDn: r.userDn,
    };
  }
  return {
    success: false,
    stage: r.stage,
    message: r.reason,
    code: r.code,
    details: r.details,
  };
}
