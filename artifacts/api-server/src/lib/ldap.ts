import { eq } from "drizzle-orm";
import { db, ldapSettingsTable } from "@workspace/db";
import { logger } from "./logger";

export async function getLdap() {
  const [row] = await db.select().from(ldapSettingsTable).where(eq(ldapSettingsTable.key, "global"));
  return row ?? null;
}

export type LdapAuthResult =
  | { ok: true; username: string; email: string; fullName: string }
  | { ok: false; reason: string };

// LDAP authenticate: bind as service account, search user, bind as user.
// We import ldapjs lazily so projects without LDAP configured don't pay the load cost.
export async function authenticateLdap(username: string, password: string): Promise<LdapAuthResult> {
  const cfg = await getLdap();
  if (!cfg || !cfg.enabled) return { ok: false, reason: "LDAP disabled" };
  if (!cfg.url || !cfg.baseDn) return { ok: false, reason: "LDAP not configured" };

  let ldap: typeof import("ldapjs");
  try {
    ldap = await import("ldapjs");
  } catch (err) {
    logger.error({ err }, "ldapjs not available");
    return { ok: false, reason: "LDAP library missing" };
  }

  return new Promise<LdapAuthResult>((resolve) => {
    // ldapTlsRejectUnauthorized in cfg overrides default (true). Only set false when admin explicitly opts in.
    const rejectUnauthorized =
      (cfg as unknown as { ldapTlsRejectUnauthorized?: boolean }).ldapTlsRejectUnauthorized !== false;
    const client = ldap.createClient({
      url: cfg.url,
      tlsOptions: cfg.tls ? { rejectUnauthorized } : undefined,
      timeout: 5000,
      connectTimeout: 5000,
    });

    let resolved = false;
    const finish = (r: LdapAuthResult) => {
      if (resolved) return;
      resolved = true;
      try {
        client.unbind();
      } catch {
        // ignore
      }
      resolve(r);
    };

    client.on("error", (err) => {
      logger.warn({ err }, "LDAP connection error");
      finish({ ok: false, reason: "LDAP connection error" });
    });

    const bindAsService = (cb: (err: Error | null) => void) => {
      if (cfg.bindDn && cfg.bindPasswordEnc) {
        client.bind(cfg.bindDn, cfg.bindPasswordEnc, (err) => cb(err));
      } else {
        cb(null);
      }
    };

    bindAsService((err) => {
      if (err) {
        finish({ ok: false, reason: "Service bind failed" });
        return;
      }
      const filter = cfg.userFilter.replace(/{{username}}/g, username);
      const opts = {
        filter,
        scope: "sub" as const,
        attributes: [cfg.usernameAttr, cfg.emailAttr, cfg.nameAttr, "dn"],
      };
      client.search(cfg.baseDn, opts, (searchErr, searchRes) => {
        if (searchErr) {
          finish({ ok: false, reason: "Search failed" });
          return;
        }
        let entry: Record<string, string> | null = null;
        let entryDn = "";
        searchRes.on("searchEntry", (e: unknown) => {
          const obj = (e as { pojo?: Record<string, unknown>; object?: Record<string, unknown>; objectName?: string }).pojo
            ?? (e as { object?: Record<string, unknown> }).object
            ?? (e as Record<string, unknown>);
          const attrs: Record<string, string> = {};
          if (obj && typeof obj === "object") {
            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
              if (Array.isArray(v)) attrs[k] = String(v[0] ?? "");
              else if (typeof v === "string") attrs[k] = v;
            }
          }
          entry = attrs;
          entryDn = (obj as { objectName?: string; dn?: string }).objectName
            ?? (obj as { dn?: string }).dn
            ?? "";
        });
        searchRes.on("error", () => finish({ ok: false, reason: "Search error" }));
        searchRes.on("end", () => {
          if (!entry || !entryDn) {
            finish({ ok: false, reason: "User not found" });
            return;
          }
          const userClient = ldap.createClient({
            url: cfg.url,
            tlsOptions: cfg.tls ? { rejectUnauthorized } : undefined,
            timeout: 5000,
            connectTimeout: 5000,
          });
          userClient.bind(entryDn, password, (bindErr) => {
            try {
              userClient.unbind();
            } catch {
              // ignore
            }
            if (bindErr) {
              finish({ ok: false, reason: "Invalid credentials" });
              return;
            }
            finish({
              ok: true,
              username: entry![cfg.usernameAttr] || username,
              email: entry![cfg.emailAttr] || `${username}@ldap.local`,
              fullName: entry![cfg.nameAttr] || username,
            });
          });
        });
      });
    });
  });
}

export async function testLdapConnection(username: string, password: string): Promise<{ success: boolean; message: string }> {
  const r = await authenticateLdap(username, password);
  if (r.ok) return { success: true, message: `Bound as ${r.username} (${r.email})` };
  return { success: false, message: r.reason };
}
