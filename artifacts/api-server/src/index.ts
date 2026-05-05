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

// HTTPS is opt-in via env so the Replit dev preview proxy (which expects
// plain HTTP on $PORT) keeps working. Production containers set
// ENABLE_HTTPS_FROM_DB=1 so the cert + key uploaded through the SSL
// settings UI are picked up automatically on container restart.
const httpsEnabled = process.env["ENABLE_HTTPS_FROM_DB"] === "1";

async function loadSslFromDb(): Promise<{ cert: string; key: string } | null> {
  try {
    const [row] = await db
      .select()
      .from(sslSettingsTable)
      .where(eq(sslSettingsTable.key, "primary"));
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
            "ENABLE_HTTPS_FROM_DB=1 but no certificate/private key found in ssl_settings. Falling back to HTTP. Upload a cert in Settings → SSL and restart.",
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
