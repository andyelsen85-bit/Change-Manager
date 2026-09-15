import crypto from "node:crypto";
import { assertStrongSecret } from "./secret-validation";

// Symmetric encryption for secrets stored in the DB (SMTP password, LDAP bind password).
// Uses AES-256-GCM with a random 12-byte IV per record. The encryption key is derived
// exclusively from APP_ENCRYPTION_KEY via HKDF-SHA256 so it is 32 bytes regardless
// of input length. It must never fall back to a session/JWT signing key: those keys
// have independent rotation and compromise boundaries.
//
// Stored format: `enc:v1:<base64(iv)>:<base64(ciphertext)>:<base64(authTag)>`
// Legacy plaintext values (no `enc:v1:` prefix) are returned as-is by `decryptSecret`
// so existing rows continue to work and are re-encrypted on the next write.

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const DEV_ENCRYPTION_KEY = "dev-only-app-encryption-key";

let cachedKey: { source: string; key: Buffer } | null = null;

function getKey(): Buffer {
  const production = (process.env["NODE_ENV"] ?? "development") === "production";
  const configured = process.env["APP_ENCRYPTION_KEY"];
  const ikm = configured || (!production ? DEV_ENCRYPTION_KEY : "");

  if (!ikm) {
    throw new Error("APP_ENCRYPTION_KEY is required to encrypt stored secrets.");
  }

  if (!configured && !production) {
    // Keep the historical explicit development key byte-for-byte compatible
    // with local ciphertext while never using JWT_SECRET as a fallback.
    const devKey = crypto.createHash("sha256").update(DEV_ENCRYPTION_KEY).digest();
    cachedKey = { source: "__dev_only__", key: devKey };
    return devKey;
  }

  if (production) assertStrongSecret("APP_ENCRYPTION_KEY", ikm);
  const cacheSource = `configured:${ikm}`;
  if (cachedKey?.source === cacheSource) return cachedKey.key;

  // Production must be configured explicitly so an existing installation cannot
  // silently receive a new key.
  const derivedKey = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(ikm, "utf8"), Buffer.alloc(0), Buffer.from("change-mgmt:secret-v1", "utf8"), 32),
  );
  cachedKey = { source: cacheSource, key: derivedKey };
  return derivedKey;
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext — return as-is
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format.");
  }
  try {
    const iv = Buffer.from(parts[0]!, "base64");
    const ct = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    if (iv.length !== IV_LEN || tag.length !== AUTH_TAG_LEN) {
      throw new Error("Invalid encrypted secret parameters.");
    }
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid encrypted secret")) {
      throw error;
    }
    throw new Error("Failed to decrypt stored secret.", { cause: error });
  }
}

export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
