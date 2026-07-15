import express, { type Express, type ErrorRequestHandler, type RequestHandler } from "express";
import cors, { type CorsOptions, type CorsRequest } from "cors";
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

// An empty allowlist is the most locked-down state, NOT an open one: it denies
// every cross-origin browser request. Same-origin calls (the frontend reaches
// the API under the same deployed host via /api path routing) never trigger
// CORS, and non-browser callers send no Origin header and are allowed below, so
// the app stays fully functional. We therefore do NOT crash on an empty
// allowlist — we only warn, so a deployment where REPLIT_DOMAINS/ALLOWED_ORIGINS
// are unavailable still boots securely. (`origin: true`, which reflects any
// origin, remains forbidden — that is the only genuinely unsafe configuration.)
if (NODE_ENV_APP === "production" && allowedOrigins.size === 0) {
  logger.warn(
    "No explicit CORS allowlist configured (REPLIT_DOMAINS and ALLOWED_ORIGINS " +
      "are both empty). All cross-origin browser requests will be denied; " +
      "same-origin and non-browser requests are unaffected. Set ALLOWED_ORIGINS " +
      "if a separate frontend origin must call this API.",
  );
}

// Normalise a possibly-array header value to its first non-empty string.
function firstHeaderValue(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.split(",")[0]?.trim();
  return trimmed ? trimmed : null;
}

// The public host the request actually arrived on. Behind a reverse proxy
// (Replit edge, or the hospital infra proxy) the original host is in
// X-Forwarded-Host; fall back to the Host header for direct connections.
function inboundHost(headers: CorsRequest["headers"]): string | null {
  return (
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers["host"])
  );
}

function originToHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

// Per-request CORS decision. We allow a request when EITHER:
//   - it is genuinely same-origin: the Origin's host equals the host the
//     request arrived on (covers every deployment alias — test/prod/custom
//     domains — with zero configuration), OR
//   - its Origin is in the explicit allowlist (ALLOWED_ORIGINS / REPLIT_DOMAINS),
//     for a separate frontend origin that must call this API cross-site.
// Otherwise no Access-Control-Allow-Origin header is emitted and the browser
// blocks the response. We never reflect arbitrary origins (`origin: true`).
//
// Why same-origin must be matched explicitly: browsers attach an Origin header
// to same-origin *mutating* requests (POST/PUT/PATCH/DELETE), so logins and
// saves on a custom domain would otherwise be rejected even though they are not
// cross-site. A real cross-site attacker's request carries its own Origin (e.g.
// evil.example) while the inbound Host still resolves to THIS API — origin and
// host differ, so it is denied. Those headers are set by the browser/edge for
// browser-mediated requests and are not attacker-controllable in that context.
function corsOptionsDelegate(
  req: CorsRequest,
  callback: (err: Error | null, options?: CorsOptions) => void,
): void {
  const origin = req.headers.origin;
  // Non-browser callers (curl, server-to-server) send no Origin header — let
  // them through; no CORS headers are required.
  if (!origin) {
    callback(null, { origin: false, credentials: true });
    return;
  }
  const oHost = originToHost(origin);
  const hHost = inboundHost(req.headers);
  const sameOrigin = !!oHost && !!hHost && oHost === hHost;
  if (sameOrigin || allowedOrigins.has(origin)) {
    callback(null, { origin, credentials: true });
  } else {
    callback(null, { origin: false, credentials: true });
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
app.use(cors(corsOptionsDelegate));
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
  // ServiceDesk Plus inbound webhook: authenticated by a shared secret
  // header, called server-to-server by SD+ (no browser session/cookie).
  "/integrations/sdp/create-change",
  "/integrations/sdp/create-change/",
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
