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

  it("checks a DATABASE_URL password but does not require POSTGRES_PASSWORD", () => {
    const env = {
      NODE_ENV: "production",
      APP_ENCRYPTION_KEY: hexSecret(),
      JWT_SECRET: hexSecret(),
      DATABASE_URL: "postgresql://db-user@managed.example/change_mgmt",
      POSTGRES_PASSWORD: "",
    };
    expect(() => validateProductionSecrets(env)).not.toThrow();
    expect(() =>
      validateProductionSecrets({
        ...env,
        DATABASE_URL: "postgresql://db-user:please-change-me@managed.example/change_mgmt",
      }),
    ).toThrow(/DATABASE_URL password/);
    expect(() =>
      validateProductionSecrets({
        ...env,
        DATABASE_URL: "postgresql://db-user:@managed.example/change_mgmt",
      }),
    ).toThrow(/DATABASE_URL password/);
  });
});
