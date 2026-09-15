import { logger } from "./lib/logger";
import { validateProductionSecrets } from "./lib/secret-validation";

// Fail closed before opening the listener or starting background workers. The
// validator is intentionally kept in the API entrypoint so importing app.ts in
// tests and local tooling remains side-effect free.
validateProductionSecrets();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Load the application and workers only after production secrets have passed
// validation. This prevents a transitive module import from using a weak
// signing or encryption key before the startup guard can fail closed.
const [{ default: app }, { runSeed }, { applyDbConstraints }, { startNotificationWorker }, { startPirReminderWorker }] =
  await Promise.all([
    import("./app"),
    import("./seed"),
    import("./lib/db-bootstrap"),
    import("./lib/notification-worker"),
    import("./lib/pir-reminder"),
  ]);

// The API server always speaks plain HTTP. TLS termination is handled by
// the nginx sidecar in front of it (see entrypoint-web). The cert/key
// uploaded through Settings → SSL must be applied to nginx, not to this
// process — wiring that lives in the container entrypoint, not here.
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
      // Background email digest worker — drains notification_queue every
      // (configurable) N minutes so users get one consolidated email
      // instead of one per event.
      startNotificationWorker();
      // Periodic PIR-deadline check — escalates to the Change Manager pool
      // when fewer than 10 days remain to complete a PIR.
      startPirReminderWorker();
    });
  });
