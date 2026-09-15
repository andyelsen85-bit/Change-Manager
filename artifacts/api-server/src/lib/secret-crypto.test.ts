import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secret-crypto";

const key = (): string => crypto.randomBytes(32).toString("hex");

describe("secret crypto", () => {
  beforeEach(() => {
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENCRYPTION_KEY"];
    delete process.env["JWT_SECRET"];
  });

  it("uses APP_ENCRYPTION_KEY independently from JWT_SECRET", () => {
    const appKey = crypto.randomBytes(32).toString("hex");
    process.env["APP_ENCRYPTION_KEY"] = appKey;
    process.env["JWT_SECRET"] = crypto.randomBytes(32).toString("hex");
    const stored = encryptSecret("preserve this value");

    process.env["JWT_SECRET"] = crypto.randomBytes(32).toString("hex");
    expect(decryptSecret(stored)).toBe("preserve this value");
  });

  it("fails explicitly for malformed or unauthentic ciphertext", () => {
    process.env["APP_ENCRYPTION_KEY"] = key();
    expect(() => decryptSecret("enc:v1:not-a-record")).toThrow(/Invalid encrypted secret format/);
    expect(() => decryptSecret("enc:v1:YWJj:YWJj:YWJj")).toThrow(/Failed to decrypt|Invalid encrypted secret/);
  });

  it("does not use JWT_SECRET as a production encryption fallback", () => {
    process.env["NODE_ENV"] = "production";
    process.env["JWT_SECRET"] = crypto.randomBytes(32).toString("hex");
    expect(() => encryptSecret("must fail without app key")).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
