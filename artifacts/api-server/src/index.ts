import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { eq } from "drizzle-orm";
import { db, sslSettingsTable } from "@workspace/db";
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

// HTTPS is on by default in deployment containers; set DISABLE_TLS=true to
// force plain HTTP (used by the Replit dev preview, whose proxy expects
// HTTP on $PORT). When TLS is enabled the cert + key uploaded through the
// SSL settings UI are read from `ssl_settings` on container restart.
const disableTls = (process.env["DISABLE_TLS"] ?? "false").toLowerCase() === "true";
const httpsEnabled = !disableTls;

async function loadSslFromDb(): Promise<{ cert: string; key: string } | null> {
  try {
    const [row] = await db
      .select()
      .from(sslSettingsTable)
      .where(eq(sslSettingsTable.key, "global"));
    if (row?.certificatePem && row?.privateKeyPem) {
      return { cert: row.certificatePem, key: row.privateKeyPem };
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Failed to read SSL settings from database");
    return null;
  }
}

function startListener() {
  const onListen = (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
  };
  if (httpsEnabled) {
    loadSslFromDb()
      .then((tls) => {
        if (tls) {
          const server = createHttpsServer({ cert: tls.cert, key: tls.key }, app);
          server.listen(port, () => onListen());
          logger.info({ port, protocol: "https" }, "Server listening (HTTPS, cert from DB)");
        } else {
          logger.warn(
            "TLS is enabled (DISABLE_TLS!=true) but no certificate/private key found in ssl_settings. Falling back to HTTP. Upload a cert in Settings → SSL and restart, or set DISABLE_TLS=true.",
          );
          const server = createHttpServer(app);
          server.listen(port, () => onListen());
          logger.info({ port, protocol: "http" }, "Server listening");
        }
      })
      .catch((err) => {
        logger.error({ err }, "FATAL: failed to bootstrap HTTPS listener");
        process.exit(1);
      });
  } else {
    const server = createHttpServer(app);
    server.listen(port, () => onListen());
    logger.info({ port, protocol: "http" }, "Server listening");
  }
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
    startListener();
  });
