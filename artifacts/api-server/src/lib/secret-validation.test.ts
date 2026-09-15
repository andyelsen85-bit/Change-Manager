import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeSecretBytes,
  inspectSecret,
  isStrongSecret,
  resolveSessionSecret,
  validateProductionSecrets,
} from "./secret-validation";

const hexSecret = (): string => crypto.randomBytes(32).toString("hex");
const base64Secret = (): string => crypto.randomBytes(32).toString("base64");
const urlBase64Secret = (): string => crypto.randomBytes(32).toString("base64url");

describe("production secret validation", () => {
  it("counts generated hex and base64 values by decoded bytes", () => {
    expect(decodeSecretBytes(Buffer.alloc(32, 0x42).toString("hex"))).toHaveLength(32);
    expect(decodeSecretBytes(Buffer.alloc(32, 0x43).toString("base64"))).toHaveLength(32);
    expect(decodeSecretBytes(Buffer.alloc(32, 0x44).toString("base64url"))).toHaveLength(32);
  });

  it("accepts strong generated formats and rejects short values", () => {
    const randomHex = crypto.randomBytes(32).toString("hex");
    const randomBase64 = crypto.randomBytes(32).toString("base64");
    expect(isStrongSecret(randomHex)).toBe(true);
    expect(isStrongSecret(randomBase64)).toBe(true);
    expect(isStrongSecret("too-short")).toBe(false);
    expect(inspectSecret("q".repeat(32)).reason).toBe("repetitive");
  });

  it("rejects placeholders without exposing their values", () => {
    for (const placeholder of [
      "please-change-me",
      "replace-with-a-long-random-string",
      "dev-only-change-mgmt-secret-do-not-use-in-prod",
      "<generate-me>",
    ]) {
      const result = inspectSecret(placeholder);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("placeholder");
    }
  });

  it("uses SESSION_SECRET first while retaining JWT_SECRET compatibility", () => {
    expect(resolveSessionSecret({ JWT_SECRET: "legacy" })).toBe("legacy");
    expect(resolveSessionSecret({ JWT_SECRET: "legacy", SESSION_SECRET: "preferred" })).toBe("preferred");
  });

  it("validates encryption and session keys independently", () => {
    const env = {
      NODE_ENV: "production",
      APP_ENCRYPTION_KEY: hexSecret(),
      SESSION_SECRET: hexSecret(),
      JWT_SECRET: hexSecret(),
      DATABASE_URL: `postgresql://db-user:${hexSecret()}@db.example/change_mgmt`,
    };
    expect(() => validateProductionSecrets(env)).not.toThrow();

    expect(() =>
      validateProductionSecrets({ ...env, APP_ENCRYPTION_KEY: "replace-with-a-long-random-string" }),
    ).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => validateProductionSecrets({ ...env, JWT_SECRET: "too-short" })).toThrow(/JWT_SECRET/);
  });

  it("leaves database password policy to PostgreSQL and does not require POSTGRES_PASSWORD", () => {
    const env = {
      NODE_ENV: "production",
      APP_ENCRYPTION_KEY: hexSecret(),
      JWT_SECRET: hexSecret(),
      DATABASE_URL: "postgresql://db-user@managed.example/change_mgmt",
      POSTGRES_PASSWORD: "",
    };
    expect(() => validateProductionSecrets(env)).not.toThrow();
    for (const password of ["x", "short-password", "please-change-me", "", "a%40b"]) {
      expect(() =>
        validateProductionSecrets({
          ...env,
          DATABASE_URL: `postgresql://db-user:${password}@managed.example/change_mgmt`,
        }),
      ).not.toThrow();
    }
    for (const url of ["", "not-a-url", "https://managed.example/db", "postgresql://user:%ZZ@managed.example/db"]) {
      expect(() => validateProductionSecrets({ ...env, DATABASE_URL: url })).toThrow(/DATABASE_URL/);
    }
    expect(() => validateProductionSecrets({ ...env, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => validateProductionSecrets({ ...env, APP_ENCRYPTION_KEY: "short" })).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
