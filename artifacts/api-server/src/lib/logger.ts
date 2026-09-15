import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
const isProductionEnvironment = (): boolean => process.env.NODE_ENV === "production";

const SENSITIVE_KEY_NAMES =
  "password|passwd|passphrase|secret|token|cookie|client[_-]?secret|bind[_-]?password|api[_-]?key|private[_-]?key|technician[_-]?key|webhook[_-]?secret";
const QUOTED_OR_TOKEN_VALUE = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\`(?:\\[\s\S]|[^\`\\])*\`|[^\s,;}\]]+`;
const SENSITIVE_ASSIGNMENT_RE = new RegExp(
  String.raw`((?<![\w-])["']?(?:${SENSITIVE_KEY_NAMES})["']?\s*[:=]\s*)(${QUOTED_OR_TOKEN_VALUE})`,
  "gi",
);
const AUTHORIZATION_ASSIGNMENT_RE = new RegExp(
  String.raw`((?<![\w-])["']?authorization["']?\s*[:=]\s*)(?:(Bearer|Basic|Digest)\s+)?(${QUOTED_OR_TOKEN_VALUE})`,
  "gi",
);
const URI_USERINFO_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s?#]+@/gi;
const PEM_BODY_RE =
  /(-----BEGIN [A-Z0-9][A-Z0-9 _-]*-----)[\s\S]*?(-----END [A-Z0-9][A-Z0-9 _-]*-----)/g;
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_ERROR_NAME_RE = /^(?:Error|TypeError|SyntaxError|[A-Z][A-Za-z0-9]+Error)$/;
const SAFE_ERROR_CODE_RE =
  /^(?:\d{1,5}|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|UND_ERR_[A-Z_]+|[A-Z][A-Za-z0-9]+Error|entity\.(?:too\.large|parse\.failed))$/;

function redactAssignedValue(prefix: string, value: string): string {
  const quote = value[0];
  const matchingQuote =
    (quote === `"` || quote === "'" || quote === "`") && value[value.length - 1] === quote;
  return `${prefix}${matchingQuote ? `${quote}[REDACTED]${quote}` : "[REDACTED]"}`;
}

function redactText(value: string): string {
  let redacted = value
    // URI userinfo is commonly where PostgreSQL/LDAP/HTTP client errors
    // expose a password. Remove the entire authority userinfo, not just a
    // `password=` fragment.
    .replace(URI_USERINFO_RE, (match) => {
      const schemeEnd = match.indexOf("://") + 3;
      return `${match.slice(0, schemeEnd)}[REDACTED]@`;
    })
    // Handle Authorization: Bearer <token> specially: a generic assignment
    // redactor would redact only the word "Bearer" and leave the token.
    .replace(AUTHORIZATION_ASSIGNMENT_RE, (_match, prefix: string, scheme: string | undefined, valuePart: string) => {
      const quote = valuePart[0];
      const matchingQuote =
        (quote === `"` || quote === "'" || quote === "`") && valuePart[valuePart.length - 1] === quote;
      if (matchingQuote) return `${prefix}${quote}[REDACTED]${quote}`;
      return `${prefix}${scheme ? `${scheme} ` : ""}[REDACTED]`;
    })
    // Quoted values may contain spaces and newlines. The value pattern above
    // consumes the complete quoted value before replacing it.
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, prefix: string, valuePart: string) =>
      redactAssignedValue(prefix, valuePart),
    )
    .replace(PEM_BODY_RE, "$1[REDACTED]$2");
  return redacted;
}

function safeToken(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && SAFE_TOKEN_RE.test(value)) return value;
  return undefined;
}

function safeName(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_NAME_RE.test(value) ? value : "Error";
}

function safeCode(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && SAFE_ERROR_CODE_RE.test(value)) return value;
  return undefined;
}

function readProperty(source: object, key: string): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function redactErrorRecord(error: unknown, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  if (depth > 5) return { name: "NestedError" };
  if (!error || typeof error !== "object") {
    if (!isProductionEnvironment() && typeof error === "string") {
      return { name: "Error", message: redactText(error) };
    }
    return { name: "NestedError" };
  }
  if (seen.has(error)) return { name: "CircularError" };
  seen.add(error);

  const source = error as object;
  const result: Record<string, unknown> = {
    name: safeName(readProperty(source, "name")),
  };
  const code = safeCode(readProperty(source, "code"));
  if (code !== undefined) result.code = code;
  const requestId = safeToken(readProperty(source, "requestId"));
  if (requestId !== undefined) result.requestId = requestId;

  // In production, omit free-form message/stack entirely. Redaction is
  // defence in depth for development diagnostics, while production logs use a
  // small allowlist that cannot accidentally reintroduce a newly-discovered
  // secret-bearing error shape.
  if (!isProductionEnvironment()) {
    const message = readProperty(source, "message");
    const stack = readProperty(source, "stack");
    if (typeof message === "string") result.message = redactText(message);
    if (typeof stack === "string") result.stack = redactText(stack);
  }

  const cause = readProperty(source, "cause");
  if (cause !== undefined) result.cause = redactErrorRecord(cause, depth + 1, seen);
  seen.delete(error);
  return result;
}

/**
 * Keep errors useful to operators without allowing credentials and certificate
 * material copied into an error message to become a log record. This is also
 * used by the API error boundary; clients never receive this representation.
 */
export function redactError(error: unknown): Record<string, unknown> {
  if (typeof error === "string") {
    return isProductionEnvironment()
      ? { name: "Error" }
      : { name: "Error", message: redactText(error) };
  }
  if (!error || typeof error !== "object") return { name: "NonError" };
  return redactErrorRecord(error, 0, new WeakSet<object>());
}

// Export the exact serializer used by pino so production-mode regression tests
// exercise the same path as `{ err }` log fields.
export const errorSerializer = redactError;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    // Most call sites use `{ err }`; serializing here makes redaction
    // consistent even when a route forgets to call redactError explicitly.
    err: errorSerializer,
  },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "req.headers['x-webhook-secret']",
    "req.headers['x-csrf-token']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
