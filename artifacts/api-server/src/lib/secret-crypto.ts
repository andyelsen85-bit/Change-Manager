import crypto from "node:crypto";

// Symmetric encryption for secrets stored in the DB (SMTP password, LDAP bind password).
// Uses AES-256-GCM with a random 12-byte IV per record. The encryption key is derived
// from APP_ENCRYPTION_KEY (preferred) or JWT_SECRET (fallback) via HKDF-SHA256 so it is
// 32 bytes regardless of input length.
//
// Stored format: `enc:v1:<base64(iv)>:<base64(ciphertext)>:<base64(authTag)>`
// Legacy plaintext values (no `enc:v1:` prefix) are returned as-is by `decryptSecret`
// so existing rows continue to work and are re-encrypted on the next write.

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";
const IV_LEN = 12;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const ikm = process.env["APP_ENCRYPTION_KEY"] || process.env["JWT_SECRET"] || "";
  if (!ikm || ikm.length < 16) {
    if ((process.env["NODE_ENV"] ?? "development") === "production") {
      throw new Error(
        "APP_ENCRYPTION_KEY (or JWT_SECRET) must be set (>=16 chars) to encrypt stored secrets.",
      );
    }
    // Dev fallback so local boots don't fail; not for production use.
    cachedKey = crypto.createHash("sha256").update("dev-only-app-encryption-key").digest();
    return cachedKey;
  }
  cachedKey = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(ikm, "utf8"), Buffer.alloc(0), Buffer.from("change-mgmt:secret-v1", "utf8"), 32),
  );
  return cachedKey;
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
  if (parts.length !== 3) return "";
  try {
    const iv = Buffer.from(parts[0]!, "base64");
    const ct = Buffer.from(parts[1]!, "base64");
    const tag = Buffer.from(parts[2]!, "base64");
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return "";
  }
}

export function isEncrypted(stored: string | null | undefined): boolean {
  return !!stored && stored.startsWith(PREFIX);
}
