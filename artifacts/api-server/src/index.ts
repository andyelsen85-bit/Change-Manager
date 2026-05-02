import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./seed";
import { applyDbConstraints } from "./lib/db-bootstrap";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// applyDbConstraints installs the audit-log immutability triggers. If this fails the
// server MUST NOT start: a running app without DB-level append-only enforcement
// silently weakens forensic integrity. Hard-fail the boot.
applyDbConstraints()
  .catch((err) => {
    logger.error({ err }, "FATAL: failed to apply DB constraints (audit-log immutability). Refusing to start.");
    process.exit(1);
  })
  .then(() => runSeed())
  .catch((err) => {
    logger.error({ err }, "Seed failed");
  })
  .finally(() => {
    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  });
