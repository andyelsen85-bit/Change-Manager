const API_BASE =
  (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ??
  (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname.replace(/-00-/, "-00-")}` : "");

function buildUrl(path: string): string {
  if (path.startsWith("http")) return path;
  return path.startsWith("/api") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
}

const CSRF_COOKIE_NAME = "cm_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Read the non-HttpOnly CSRF cookie set by the API on login. Used to echo
// the token back as the X-CSRF-Token header on every mutating request
// (double-submit cookie pattern).
function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const entry of cookies) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const name = entry.slice(0, eq);
    if (name === CSRF_COOKIE_NAME) {
      try {
        return decodeURIComponent(entry.slice(eq + 1));
      } catch {
        return entry.slice(eq + 1);
      }
    }
  }
  return null;
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// Hits /auth/me which the API uses to heal sessions that pre-date the CSRF
// rollout (or whose CSRF cookie was pruned by the browser) by minting a
// fresh `cm_csrf` cookie. Used as a one-shot recovery after a 403
// "Invalid or missing CSRF token" so the user does not have to log out.
async function refreshCsrfCookie(): Promise<string | null> {
  try {
    const res = await fetch(buildUrl("/auth/me"), { credentials: "include" });
    if (!res.ok) return null;
    return readCsrfCookie();
  } catch {
    return null;
  }
}

async function performFetch(path: string, init: RequestInit): Promise<Response> {
  const url = buildUrl(path);
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) headers.set("accept", "application/json, text/plain, */*");
  const method = (init.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method) && !headers.has("x-csrf-token")) {
    const token = readCsrfCookie();
    if (token) headers.set("x-csrf-token", token);
  }
  return fetch(url, { ...init, headers, credentials: "include" });
}

function isCsrfFailure(status: number, data: unknown): boolean {
  if (status !== 403) return false;
  if (data && typeof data === "object" && "error" in data) {
    const err = (data as { error: unknown }).error;
    return typeof err === "string" && err.toLowerCase().includes("csrf");
  }
  return false;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await performFetch(path, init);
  let text = await res.text();
  let data: unknown = null;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  // Stale-session recovery: if the request was a state-changing call and was
  // rejected with a CSRF error, hit /auth/me to mint a fresh CSRF cookie and
  // retry the original request exactly once. This is what unblocks users who
  // were already signed in before CSRF protection was deployed.
  const method = (init.method ?? "GET").toUpperCase();
  if (!res.ok && !SAFE_METHODS.has(method) && isCsrfFailure(res.status, data)) {
    const refreshed = await refreshCsrfCookie();
    if (refreshed) {
      res = await performFetch(path, init);
      text = await res.text();
      data = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
    }
  }
  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : null) ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body == null ? undefined : JSON.stringify(body) }),
  delete: <T = void>(path: string) => request<T>(path, { method: "DELETE" }),
  download: async (path: string, filename: string) => {
    const url = buildUrl(path);
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`, null);
    const blob = await res.blob();
    const a = document.createElement("a");
    const objectUrl = URL.createObjectURL(blob);
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  },
};

export const API_BASE_URL = API_BASE;
