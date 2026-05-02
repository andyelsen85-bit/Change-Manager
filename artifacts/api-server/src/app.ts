import express, { type Express, type ErrorRequestHandler, type RequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireCsrf } from "./lib/auth";

const app: Express = express();

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
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

// CSRF protection (double-submit cookie). Login is exempt because the user
// has no session yet — login is what issues the CSRF token. All other
// state-changing requests under /api must include a matching X-CSRF-Token
// header that mirrors the `cm_csrf` cookie value set on login. The exemption
// is scoped to POST and tolerates a trailing slash so unintended verbs on
// /auth/login still go through the CSRF check.
const csrfGate: RequestHandler = (req, res, next) => {
  if (req.method === "POST" && (req.path === "/auth/login" || req.path === "/auth/login/")) {
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
