// ManageEngine ServiceDesk Plus (on-premises) integration client.
//
// SD+ on-prem authenticates with a static technician API key sent as the
// `technician_key` header. The v3 REST API expects a form-encoded
// `input_data` JSON payload. We use it for three operations:
//   * test connection (list one request)
//   * add a note with the Change-it back-link when a change is created
//   * resolve / reject the originating request when the change terminates
//
// All outbound sync calls are best-effort: failures are logged and audited
// but never block the change workflow.
import { eq } from "drizzle-orm";
import { db, sdpSettingsTable, auditLogTable, type ChangeRow } from "@workspace/db";
import { decryptSecret } from "./secret-crypto";
import { logger } from "./logger";

const KEY = "global";

export type SdpConfig = typeof sdpSettingsTable.$inferSelect;

export async function getSdpConfig(): Promise<SdpConfig | undefined> {
  const [row] = await db.select().from(sdpSettingsTable).where(eq(sdpSettingsTable.key, KEY));
  return row;
}

function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

// Public URL of the SD+ request in the technician UI — used for the
// clickable link on the change detail page.
export function sdpRequestUrl(cfg: Pick<SdpConfig, "baseUrl">, requestId: string): string {
  return `${normalizeBaseUrl(cfg.baseUrl)}/WorkOrder.do?woMode=viewWO&woID=${encodeURIComponent(requestId)}`;
}

// Base URL of THIS app, used for back-links written into SD+ tickets.
export function appBaseUrl(): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const dev = process.env.REPLIT_DEV_DOMAIN;
  if (dev) return `https://${dev}`;
  return "";
}

async function sdpFetch(
  cfg: SdpConfig,
  path: string,
  opts: { method: string; inputData?: unknown },
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${normalizeBaseUrl(cfg.baseUrl)}${path}`;
  const technicianKey = cfg.technicianKeyEnc ? decryptSecret(cfg.technicianKeyEnc) : "";
  const headers: Record<string, string> = {
    technician_key: technicianKey,
    Accept: "application/vnd.manageengine.sdp.v3+json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const init: Record<string, unknown> = { method: opts.method, headers };
  if (opts.inputData !== undefined) {
    init.body = new URLSearchParams({ input_data: JSON.stringify(opts.inputData) }).toString();
  }
  // Allow self-signed certificates on internal SD+ servers when the admin
  // explicitly disabled TLS verification (mirrors the SMTP/LDAP toggles).
  if (!cfg.tlsRejectUnauthorized && url.startsWith("https:")) {
    const { Agent } = await import("undici");
    init.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal } as unknown as RequestInit);
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function testSdpConnection(): Promise<{ success: boolean; message: string }> {
  const cfg = await getSdpConfig();
  if (!cfg || !cfg.baseUrl) return { success: false, message: "SD+ base URL is not configured." };
  if (!cfg.technicianKeyEnc) return { success: false, message: "Technician API key is not set." };
  try {
    const r = await sdpFetch(cfg, "/api/v3/requests?input_data=" + encodeURIComponent(JSON.stringify({ list_info: { row_count: 1 } })), {
      method: "GET",
    });
    if (r.ok) return { success: true, message: "Connected to ServiceDesk Plus successfully." };
    if (r.status === 401 || r.status === 403)
      return { success: false, message: `Authentication failed (HTTP ${r.status}). Check the technician API key.` };
    return { success: false, message: `SD+ responded with HTTP ${r.status}: ${r.body.slice(0, 300)}` };
  } catch (err) {
    return { success: false, message: `Connection failed: ${describeFetchError(err)}` };
  }
}

// undici wraps network errors in a generic "fetch failed" TypeError; the
// actionable detail (DNS, timeout, TLS, refused) lives in err.cause.
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const causeMsg =
    cause instanceof Error
      ? `${(cause as NodeJS.ErrnoException).code ? `[${(cause as NodeJS.ErrnoException).code}] ` : ""}${cause.message}`
      : cause
        ? String(cause)
        : "";
  if (err.name === "AbortError") return "Timed out after 15s. The server did not respond — check that it is reachable from the internet.";
  let msg = causeMsg ? `${err.message} — ${causeMsg}` : err.message;
  if (/ENOTFOUND/.test(msg)) msg += ". The hostname could not be resolved from Change-it's network — internal-only DNS names are not reachable from here.";
  else if (/ECONNREFUSED/.test(msg)) msg += ". The server refused the connection — check the port and that the SD+ API is exposed externally.";
  else if (/ETIMEDOUT|ECONNRESET|UND_ERR_CONNECT_TIMEOUT/.test(msg)) msg += ". No response from the server — likely blocked by a firewall or not reachable from the internet.";
  else if (/certificate|CERT|self[- ]signed|unable to verify/i.test(msg)) msg += ". TLS certificate problem — if SD+ uses an internal/self-signed certificate, enable the self-signed certificate toggle.";
  return msg;
}

// Timeline of the change's lifecycle taken from the audit log — pushed into
// the SD+ resolution field so the ticket carries the full history.
async function buildMilestoneText(changeId: number): Promise<string> {
  const rows = await db
    .select()
    .from(auditLogTable)
    .where(eq(auditLogTable.entityId, changeId));
  const relevant = rows
    .filter(
      (r) =>
        r.entityType === "change" &&
        ["change.created", "change.transitioned", "change.reverted", "approval.voted"].includes(r.action),
    )
    .sort((a, b) => new Date(a.timestamp as unknown as string).getTime() - new Date(b.timestamp as unknown as string).getTime());
  return relevant
    .map((r) => {
      const ts = new Date(r.timestamp as unknown as string).toISOString().replace("T", " ").slice(0, 16);
      return `${ts} — ${r.summary}`;
    })
    .join("\n");
}

// Add a note to the SD+ request pointing back to the Change-it change.
export async function sdpAddBackLinkNote(requestId: string, change: ChangeRow): Promise<void> {
  const cfg = await getSdpConfig();
  if (!cfg?.enabled) return;
  const base = appBaseUrl();
  const link = base ? `${base}/changes/${change.id}` : `(change #${change.id})`;
  const description =
    `A change request has been created in Change-it for this ticket.<br>` +
    `Reference: <b>${change.ref}</b> — ${escapeHtml(change.title)}<br>` +
    (base ? `Link: <a href="${link}">${link}</a>` : "");
  try {
    const r = await sdpFetch(cfg, `/api/v3/requests/${encodeURIComponent(requestId)}/notes`, {
      method: "POST",
      inputData: { note: { description, show_to_requester: false } },
    });
    if (!r.ok) logger.warn({ requestId, status: r.status, body: r.body.slice(0, 300) }, "SD+ back-link note failed");
  } catch (err) {
    logger.warn({ requestId, err: String(err) }, "SD+ back-link note failed");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Resolve or reject the originating SD+ request when the linked change
// reaches a terminal state. `outcome` maps to the SD+ status name; the
// resolution content carries the milestone timeline and (for rejections)
// the mandatory rejection note.
export async function sdpSyncTerminalState(
  change: ChangeRow,
  outcome: "Resolved" | "Rejected",
  note?: string | null,
): Promise<{ success: boolean; message: string }> {
  if (!change.sdpRequestId) return { success: false, message: "No linked SD+ request." };
  const cfg = await getSdpConfig();
  if (!cfg?.enabled) return { success: false, message: "SD+ integration disabled." };
  try {
    const milestones = await buildMilestoneText(change.id);
    const base = appBaseUrl();
    const lines: string[] = [];
    lines.push(
      outcome === "Resolved"
        ? `Change ${change.ref} (“${change.title}”) was completed in Change-it.`
        : `Change ${change.ref} (“${change.title}”) was REJECTED in Change-it.`,
    );
    if (outcome === "Rejected" && note) lines.push(`\nRejection note:\n${note}`);
    if (base) lines.push(`\nChange link: ${base}/changes/${change.id}`);
    if (milestones) lines.push(`\nChange history:\n${milestones}`);
    const content = lines.join("\n");
    const r = await sdpFetch(cfg, `/api/v3/requests/${encodeURIComponent(change.sdpRequestId)}`, {
      method: "PUT",
      inputData: {
        request: {
          resolution: { content: escapeHtml(content).replace(/\n/g, "<br>") },
          status: { name: outcome },
        },
      },
    });
    if (r.ok) {
      logger.info({ changeId: change.id, sdpRequestId: change.sdpRequestId, outcome }, "SD+ request synced");
      return { success: true, message: `SD+ request ${change.sdpRequestId} set to ${outcome}.` };
    }
    logger.warn(
      { changeId: change.id, sdpRequestId: change.sdpRequestId, status: r.status, body: r.body.slice(0, 500) },
      "SD+ terminal-state sync failed",
    );
    return { success: false, message: `SD+ responded with HTTP ${r.status}` };
  } catch (err) {
    logger.warn({ changeId: change.id, err: String(err) }, "SD+ terminal-state sync failed");
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
