import express, { type Express, type Request, type Response, type NextFunction } from "express";
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

export class DbMock {
  queue: QueuedResult[] = [];

  reset(): void {
    this.queue = [];
  }

  enqueue(call: DbCall, data: unknown): void {
    this.queue.push({ call, data });
  }

  private chain(call: DbCall): unknown {
    const queue = this.queue;
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
        return () => proxy;
      },
    };
    const proxy: unknown = new Proxy({}, handler);
    return proxy;
  }

  select = (..._args: unknown[]): unknown => this.chain("select");
  insert = (..._args: unknown[]): unknown => this.chain("insert");
  update = (..._args: unknown[]): unknown => this.chain("update");
  delete = (..._args: unknown[]): unknown => this.chain("delete");
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
      req.session = session;
    }
    next();
  });
  app.use("/api", router);
  return app;
}

export const ADMIN_SESSION: SessionPayload = {
  uid: 1,
  username: "admin",
  isAdmin: true,
};
export const OWNER_SESSION: SessionPayload = {
  uid: 10,
  username: "owner",
  isAdmin: false,
};
export const ASSIGNEE_SESSION: SessionPayload = {
  uid: 20,
  username: "assignee",
  isAdmin: false,
};
export const STRANGER_SESSION: SessionPayload = {
  uid: 99,
  username: "stranger",
  isAdmin: false,
};
export const CHANGE_MANAGER_SESSION: SessionPayload = {
  uid: 30,
  username: "cm",
  isAdmin: false,
};

export const ACCESS: Record<string, ChangeAccessReason> = {
  admin: "admin",
  owner: "owner",
  assignee: "assignee",
  change_manager: "change_manager",
  none: null,
};
