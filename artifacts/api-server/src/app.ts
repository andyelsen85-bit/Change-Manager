import express, { type Express, type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireCsrf } from "./lib/auth";

const app: Express = express();

// Build the set of origins that may make credentialed cross-origin requests to
// this API. The allowlist is built from two sources:
//   1. ALLOWED_ORIGINS — an optional, explicit comma-separated override (e.g.
//      a custom frontend domain that differs from the Replit-served domain).
//   2. REPLIT_DOMAINS — the platform-provided domain(s) that actually serve
//      this app in both development and production. Deriving from this means
//      the deployment is self-configuring: the app's own origin is always
//      trusted without anyone having to hand-set ALLOWED_ORIGINS.
// In development we additionally allow the standard localhost dev-server ports.
// Reflecting arbitrary request origins (`origin: true`) is explicitly forbidden:
// it would let any malicious site read authenticated API responses via
// `fetch(..., { credentials: "include" })`.
const NODE_ENV_APP = process.env["NODE_ENV"] ?? "development";
const rawAllowedOrigins = process.env["ALLOWED_ORIGINS"] ?? "";
const configuredOrigins: string[] = rawAllowedOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// REPLIT_DOMAINS is a comma-separated list of bare hostnames (no scheme). The
// platform serves the app over HTTPS, so each becomes an https:// origin.
const platformOrigins: string[] = (process.env["REPLIT_DOMAINS"] ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => `https://${d}`);

// In development, supplement with the standard localhost ports used by Vite /
// the front-end dev server.
const DEV_LOCALHOST_ORIGINS =
  NODE_ENV_APP !== "production"
    ? [
        "http://localhost:3000",
        "http://localhost:4000",
        "http://localhost:5173",
        "http://localhost:8080",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
      ]
    : [];

const allowedOrigins: Set<string> = new Set([
  ...configuredOrigins,
  ...platformOrigins,
  ...DEV_LOCALHOST_ORIGINS,
]);

// Refuse to start in production with no allowlist at all — that would mean no
// CORS isolation. Normally REPLIT_DOMAINS supplies the app's own origin; this
// guard only trips if neither REPLIT_DOMAINS nor ALLOWED_ORIGINS is available.
if (NODE_ENV_APP === "production" && allowedOrigins.size === 0) {
  throw new Error(
    "No CORS allowlist could be determined in production. " +
      "Set ALLOWED_ORIGINS (comma-separated frontend origin[s]) or ensure " +
      "REPLIT_DOMAINS is present. Refusing to start with an open CORS policy.",
  );
}

function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  // Non-browser callers (curl, server-to-server) send no Origin header — allow
  // them through so CLI tooling and internal services are not blocked.
  if (!origin) {
    callback(null, true);
    return;
  }
  if (allowedOrigins.has(origin)) {
    callback(null, true);
  } else {
    callback(new Error(`CORS: origin '${origin}' is not allowed`));
  }
}

// We sit behind the Replit edge / preview proxy, which terminates TLS and
// forwards over HTTP with `X-Forwarded-Proto: https`. Trusting that header
// lets `req.secure` reflect the original scheme so we can correctly emit
// `Secure; SameSite=None` cookies for the iframe context.
app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ origin: corsOriginCheck, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// CSRF protection (double-submit cookie). Login and first-time setup are
// exempt because the user has no session yet — those endpoints are what
// issue the CSRF token. All other state-changing requests under /api must
// include a matching X-CSRF-Token header that mirrors the `cm_csrf` cookie
// value set on login/setup. The exemption is scoped to POST and tolerates a
// trailing slash so unintended verbs on these paths still go through the
// CSRF check.
const CSRF_EXEMPT_POST_PATHS = new Set([
  "/auth/login",
  "/auth/login/",
  "/auth/setup",
  "/auth/setup/",
]);
const csrfGate: RequestHandler = (req, res, next) => {
  if (req.method === "POST" && CSRF_EXEMPT_POST_PATHS.has(req.path)) {
    next();
    return;
  }
  requireCsrf(req, res, next);
};
app.use("/api", csrfGate);

app.use("/api", router);

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  req.log?.error({ err }, "Unhandled request error");
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
};
app.use(errorHandler);

export default app;
