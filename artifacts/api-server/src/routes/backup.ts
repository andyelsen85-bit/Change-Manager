import { Router, type IRouter, json as expressJson, type Request, type Response, type NextFunction } from "express";
import { requireAdmin } from "../lib/auth";
import { exportAll, importAll } from "../lib/backup";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";

const router: IRouter = Router();

// Defence-in-depth against credentialed cross-origin reads of full backups:
// the global CORS policy reflects the request origin (`origin: true`) which,
// combined with `credentials: true` and SameSite=None session cookies, would
// let a malicious page fetch a backup if an admin were signed in. Backup
// endpoints reject any request whose Origin header doesn't match the Host —
// same-origin browser calls (where Origin equals our host) and non-browser
// callers (where Origin is absent, e.g. curl with the cookie) still work.
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      res.status(403).json({ error: "Cross-origin requests are not allowed for backup endpoints" });
      return;
    }
    const host = req.headers.host ?? "";
    if (originHost !== host) {
      res.status(403).json({ error: "Cross-origin requests are not allowed for backup endpoints" });
      return;
    }
  }
  next();
}

router.get("/backup", requireSameOrigin, requireAdmin, async (req, res, next) => {
  try {
    const payload = await exportAll();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="change-mgmt-backup-${stamp}.json"`);
    await audit(req, {
      action: "backup.export",
      entityType: "system",
      summary: `Exported full backup (${Object.keys(payload.tables).length} tables)`,
    });
    res.send(JSON.stringify(payload));
  } catch (err) {
    next(err);
  }
});

// Backups can easily exceed the global 5mb JSON limit on busy installs, so we
// install a route-local parser with a much higher ceiling. requireAdmin still
// gates access so this isn't exposed to anonymous traffic.
// Validation errors (bad/missing payload shape) thrown synchronously by
// importAll's `validate()` happen before any DB work. We treat them as 400
// so admins see "missing rows for table X" instead of a generic 500. Any
// other error happens mid-transaction (already rolled back inside importAll)
// and is forwarded to the centralized error handler so it gets logged with
// a stack trace and returns 500.
const VALIDATION_PREFIXES = ["Backup payload", "Unsupported backup version"];
function isValidationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return VALIDATION_PREFIXES.some((p) => err.message.startsWith(p));
}

router.post(
  "/backup/restore",
  requireSameOrigin,
  requireAdmin,
  expressJson({ limit: "200mb" }),
  async (req, res, next) => {
    try {
      const body = req.body as unknown;
      const result = await importAll(body);
      logger.warn({ restored: result.restored, actor: req.session?.uid }, "Database restored from backup");
      // Audit AFTER restore so the entry survives in the new dataset.
      await audit(req, {
        action: "backup.restore",
        entityType: "system",
        summary: `Restored full backup (${Object.values(result.restored).reduce((a, b) => a + b, 0)} rows across ${Object.keys(result.restored).length} tables)`,
        after: result.restored,
      });
      res.json({ ok: true, restored: result.restored });
    } catch (err) {
      if (isValidationError(err)) {
        res.status(400).json({ ok: false, error: (err as Error).message });
        return;
      }
      next(err);
    }
  },
);

export default router;
