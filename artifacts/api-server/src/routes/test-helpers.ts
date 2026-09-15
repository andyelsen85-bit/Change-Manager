import express, { type Express, type Request, type Response, type NextFunction } from "express";
import expressSession from "express-session";
import type { SessionPayload, ChangeAccessReason } from "../lib/auth";

// A queue-based mock for drizzle's chainable query API. Each test enqueues the
// expected return value(s) for upcoming `db.select()` / `db.insert()` /
// `db.update()` / `db.delete()` calls. Any chain method (.from, .where,
// .leftJoin, .orderBy, .set, .values, .returning, .onConflictDoUpdate, etc.)
// returns the same chain; awaiting the chain pops the next queued result.
export type DbCall = "select" | "insert" | "update" | "delete";
export interface QueuedResult {
  call: DbCall;
  data: unknown;
}

export interface ChainLogEntry {
  call: DbCall;
  method: string;
  args: unknown[];
}

export class DbMock {
  queue: QueuedResult[] = [];
  // Every chained method invocation (e.g. .values(...), .set(...),
  // .onConflictDoUpdate(...)) is recorded here so tests can assert on the
  // arguments passed to the query builder, not just the queued results.
  log: ChainLogEntry[] = [];

  reset(): void {
    this.queue = [];
    this.log = [];
  }

  enqueue(call: DbCall, data: unknown): void {
    this.queue.push({ call, data });
  }

  private chain(call: DbCall): unknown {
    const queue = this.queue;
    const log = this.log;
    const handler: ProxyHandler<object> = {
      get(target, prop) {
        if (prop === "then") {
          return (
            resolve: (v: unknown) => unknown,
            reject?: (r: unknown) => unknown,
          ) => {
            const next = queue.shift();
            if (!next) {
              return Promise.reject(
                new Error(`DbMock: no queued result for ${call}`),
              ).then(resolve, reject);
            }
            return Promise.resolve(next.data).then(resolve, reject);
          };
        }
        if (prop === Symbol.toPrimitive || prop === "toString") {
          return target[prop as keyof typeof target];
        }
        return (...args: unknown[]) => {
          log.push({ call, method: String(prop), args });
          return proxy;
        };
      },
    };
    const proxy: unknown = new Proxy({}, handler);
    return proxy;
  }

  select = (..._args: unknown[]): unknown => this.chain("select");
  insert = (..._args: unknown[]): unknown => {
    this.log.push({ call: "insert", method: "insert", args: _args });
    return this.chain("insert");
  };
  update = (..._args: unknown[]): unknown => this.chain("update");
  delete = (..._args: unknown[]): unknown => {
    this.log.push({ call: "delete", method: "delete", args: _args });
    return this.chain("delete");
  };
  // Routes run multi-statement writes inside db.transaction(async (tx) => …).
  // The mock just passes itself through — queued results are shared.
  transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => fn(this);
}

// Build a test Express app with a fixed session and CSRF disabled.
export function buildTestApp(
  router: express.Router,
  session: SessionPayload | null,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) {
      req.session = { ...session, generation: session.generation ?? 0 } as typeof req.session;
    }
    next();
  });
  app.use("/api", router);
  return app;
}

/**
 * Auth-route tests mount routers directly rather than app.ts. Use a real
 * in-memory express-session middleware there so login/setup/ADFS tests still
 * exercise regeneration and cookie issuance without touching PostgreSQL.
 */
export function installTestSession(app: Express): void {
  app.use(
    expressSession({
      secret: "test-only-session-secret",
      name: "cm_session",
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: { maxAge: 12 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax", path: "/" },
    }),
  );
}

export const ADMIN_SESSION: SessionPayload = {
  uid: 1,
  username: "admin",
  isAdmin: true,
  generation: 0,
};
export const OWNER_SESSION: SessionPayload = {
  uid: 10,
  username: "owner",
  isAdmin: false,
  generation: 0,
};
export const ASSIGNEE_SESSION: SessionPayload = {
  uid: 20,
  username: "assignee",
  isAdmin: false,
  generation: 0,
};
export const STRANGER_SESSION: SessionPayload = {
  uid: 99,
  username: "stranger",
  isAdmin: false,
  generation: 0,
};
export const CHANGE_MANAGER_SESSION: SessionPayload = {
  uid: 30,
  username: "cm",
  isAdmin: false,
  generation: 0,
};

export type SessionLike = SessionPayload;

export const ACCESS: Record<string, ChangeAccessReason> = {
  admin: "admin",
  owner: "owner",
  assignee: "assignee",
  change_manager: "change_manager",
  none: null,
};
