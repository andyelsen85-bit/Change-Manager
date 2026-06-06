import express, { type Express, type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireCsrf } from "./lib/auth";

const app: Express = express();

// Build the set of origins that may make credentialed cross-origin requests to
// this API. In production, ALLOWED_ORIGINS must be set to the exact frontend
// origin(s) (comma-separated, no wildcards). In development we fall back to
// common localhost ports so the dev workflow keeps working without extra
// configuration. Reflecting arbitrary request origins (`origin: true`) is
// explicitly forbidden: it would let any malicious site read authenticated
// API responses via `fetch(..., { credentials: "include" })`.
const NODE_ENV_APP = process.env["NODE_ENV"] ?? "development";
const rawAllowedOrigins = process.env["ALLOWED_ORIGINS"] ?? "";
const configuredOrigins: Set<string> = new Set(
  rawAllowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

// Warn loudly in production when no explicit list was provided, then refuse
// to start — a missing allowlist in production means no CORS isolation at all.
if (NODE_ENV_APP === "production" && configuredOrigins.size === 0) {
  throw new Error(
    "ALLOWED_ORIGINS environment variable is required in production. " +
      "Set it to the frontend origin(s) (comma-separated) to enable CORS. " +
      "Refusing to start with an open CORS policy.",
  );
}

// In development, supplement whatever is in ALLOWED_ORIGINS with the standard
// localhost ports used by Vite / the front-end dev server.
const DEV_LOCALHOST_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:4000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];
const allowedOrigins: Set<string> =
  NODE_ENV_APP !== "production"
    ? new Set([...configuredOrigins, ...DEV_LOCALHOST_ORIGINS])
    : configuredOrigins;

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
