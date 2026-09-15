import { Buffer } from "node:buffer";

/**
 * A production secret must contain at least 32 bytes of material.  Hex and
 * base64 values are decoded before this check so that, for example, the
 * 64-character hex value emitted by `openssl rand -hex 32` is correctly
 * counted as 32 bytes rather than 64 characters.
 */
export const MIN_SECRET_BYTES = 32;

const PLACEHOLDER_VALUES = new Set([
  "changeme",
  "change-me",
  "change_me",
  "please-change-me",
  "please_change_me",
  "replace-me",
  "replace_me",
  "replace-with-a-long-random-string",
  "replace_with_a_long_random_string",
  "your-secret-here",
  "your_secret_here",
  "your-secret",
  "your_secret",
  "secret",
  "password",
  "jwt-secret",
  "jwt_secret",
  "app-encryption-key",
  "app_encryption_key",
  "session-secret",
  "session_secret",
  "dev-only-change-mgmt-secret-do-not-use-in-prod",
  "dev-only-app-encryption-key",
]);

export type SecretStrength = {
  valid: boolean;
  byteLength: number;
  reason?: "missing" | "placeholder" | "too_short" | "repetitive";
};

function decodeBase64(value: string): Buffer | null {
  // Do not let Buffer.from silently discard malformed characters.  URL-safe
  // base64 is accepted because it is a common output of secret generators.
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) return null;
  if (value.includes("=") && !/=+$/.test(value)) return null;

  const unpadded = value.replace(/=+$/, "");
  if (!unpadded || unpadded.length % 4 === 1) return null;
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(padded, "base64");
  if (!decoded.length) return null;

  // Compare the canonical representation, ignoring optional padding.  This
  // rejects strings that merely contain a few base64-looking characters.
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  return canonical === normalized ? decoded : null;
}

/**
 * Return the bytes represented by a configured secret. Values which are not
 * recognised encoded representations are treated as UTF-8 secret material.
 */
export function decodeSecretBytes(value: string): Buffer {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, "hex");
  }

  // A 32-character plain secret is intentionally treated as plain text.  The
  // shortest generated base64 representation of 32 bytes is 43 characters,
  // which avoids misclassifying ordinary 32-character passwords here.
  const looksLikeBase64 =
    value.length >= 40 || value.includes("=") || value.includes("-") || value.includes("_");
  if (looksLikeBase64) {
    const decoded = decodeBase64(value);
    if (decoded) return decoded;
  }

  return Buffer.from(value, "utf8");
}

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || PLACEHOLDER_VALUES.has(normalized)) return true;
  if (/^<[^>]+>$/.test(normalized)) return true;
  if (/^(?:x|y|z|0|1|a){4,}$/.test(normalized)) return true;
  if (/^(?:secret|password|replace|change|please)[-_ ]?(?:me|here|this)?$/.test(normalized)) {
    return true;
  }
  return false;
}

function isRepetitive(value: string): boolean {
  if (value.length < MIN_SECRET_BYTES) return true;
  // A generated value can contain repeated characters, but not an entire
  // 32-byte value made from one character or a short repeated token.
  if (/^(.)\1+$/.test(value)) return true;
  if (/^(.{1,4})\1+$/.test(value)) return true;
  return false;
}

export function inspectSecret(value: unknown): SecretStrength {
  if (typeof value !== "string" || value.length === 0) {
    return { valid: false, byteLength: 0, reason: "missing" };
  }

  if (isPlaceholder(value)) {
    return { valid: false, byteLength: 0, reason: "placeholder" };
  }

  const bytes = decodeSecretBytes(value);
  if (bytes.length < MIN_SECRET_BYTES) {
    return { valid: false, byteLength: bytes.length, reason: "too_short" };
  }
  if (isRepetitive(value)) {
    return { valid: false, byteLength: bytes.length, reason: "repetitive" };
  }
  return { valid: true, byteLength: bytes.length };
}

export function isStrongSecret(value: unknown): boolean {
  return inspectSecret(value).valid;
}

export function assertStrongSecret(name: string, value: unknown): void {
  const result = inspectSecret(value);
  if (result.valid) return;

  const reason =
    result.reason === "missing"
      ? "is required"
      : result.reason === "placeholder"
        ? "must not be a placeholder"
        : result.reason === "repetitive"
          ? "must contain random-looking secret material"
          : `must contain at least ${MIN_SECRET_BYTES} bytes`;
  throw new Error(`${name} ${reason}.`);
}

export function resolveSessionSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env["SESSION_SECRET"] || env["JWT_SECRET"] || undefined;
}

function validateDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme.");
  }

  // Database credential policy belongs to the database administrator.
  // Check URL encoding only, never password length or strength.
  try {
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error("DATABASE_URL contains an invalid encoded password.");
  }
}

/**
 * Validate secrets which are needed by a production API before any listeners
 * or workers are started.  POSTGRES_PASSWORD is deliberately not inspected:
 * DATABASE_URL is the source of truth and externally managed databases do not
 * need a second, redundant password variable.
 */
export function validateProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if ((env["NODE_ENV"] ?? "development") !== "production") return;

  const errors: string[] = [];
  const check = (name: string, value: unknown): void => {
    try {
      assertStrongSecret(name, value);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${name} is invalid.`);
    }
  };

  check("APP_ENCRYPTION_KEY", env["APP_ENCRYPTION_KEY"]);

  const sessionSecret = env["SESSION_SECRET"];
  const jwtSecret = env["JWT_SECRET"];
  if (!sessionSecret && !jwtSecret) {
    errors.push("SESSION_SECRET (or JWT_SECRET for compatibility) is required.");
  } else {
    // Validate both values when both are configured.  A weak compatibility
    // value must not remain enabled merely because a preferred value exists.
    if (sessionSecret) check("SESSION_SECRET", sessionSecret);
    if (jwtSecret) check("JWT_SECRET", jwtSecret);
  }

  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) {
    errors.push("DATABASE_URL is required.");
  } else {
    try {
      validateDatabaseUrl(databaseUrl);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "DATABASE_URL is invalid.");
    }
  }

  if (errors.length > 0) {
    throw new Error(`Production secret validation failed: ${errors.join(" ")}`);
  }
}
