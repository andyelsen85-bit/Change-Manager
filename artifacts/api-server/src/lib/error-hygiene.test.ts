import { describe, expect, it, vi } from "vitest";
import { importAll, BackupValidationError } from "./backup";
import { errorSerializer, redactError } from "./logger";

// Validation completes before backup restore obtains a pool connection. Keep
// this unit test independent of a configured database.
vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn() },
}));

describe("error hygiene", () => {
  function leakyError(): Error & { code: string; requestId: string } {
    const cause = new Error(
      'nested failure password="nested secret with spaces\nand a second line"',
    );
    const error = new Error(
      [
        "database connection failed",
        "postgresql://db-user:postgres-secret@db.internal.example/changeit",
        "Authorization: Bearer bearer-secret-value",
        'password="quoted secret with spaces\nand a second line"',
        "token: 'token with spaces\nand a second line'",
        '{"authorization":"Bearer json-secret-value"}',
      ].join("\n"),
    ) as Error & { code: string; requestId: string };
    Object.defineProperty(error, "cause", { value: cause });
    error.code = "ECONNREFUSED";
    error.requestId = "req-123";
    return error;
  }

  it("redacts URI userinfo, authorization tokens, quoted multiline values, PEMs, and causes", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const error = leakyError();
      error.stack = `${error.stack}\n-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----`;
      const encoded = JSON.stringify(redactError(error));

      expect(encoded).not.toContain("postgres-secret");
      expect(encoded).not.toContain("bearer-secret-value");
      expect(encoded).not.toContain("json-secret-value");
      expect(encoded).not.toContain("quoted secret with spaces");
      expect(encoded).not.toContain("token with spaces");
      expect(encoded).not.toContain("nested secret with spaces");
      expect(encoded).not.toContain("private-key");
      expect(encoded).toContain("[REDACTED]");
      expect(encoded).toContain("postgresql://[REDACTED]@db.internal.example");
      expect(encoded).toContain("requestId");
      expect(encoded).toContain("ECONNREFUSED");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it("uses only an allowlisted production serializer shape", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const serialized = errorSerializer(leakyError());
      const encoded = JSON.stringify(serialized);

      expect(serialized).toMatchObject({
        name: "Error",
        code: "ECONNREFUSED",
        requestId: "req-123",
      });
      expect(serialized).not.toHaveProperty("message");
      expect(serialized).not.toHaveProperty("stack");
      expect(encoded).not.toContain("postgres-secret");
      expect(encoded).not.toContain("bearer-secret-value");
      expect(encoded).not.toContain("nested secret with spaces");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it.each(["22P02", "42P01", "23503", "42501"])("preserves SQLSTATE %s without logging database values", (code) => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const error = Object.assign(new Error("invalid JSON: confidential backup content"), {
        code,
        detail: "confidential row values",
        query: "INSERT containing confidential values",
      });
      expect(errorSerializer(error)).toEqual({ name: "Error", code });
      expect(errorSerializer({ code: "22P02 confidential" })).toEqual({ name: "Error" });
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it("does not echo arbitrary backup version input in validation errors", async () => {
    const attackerValue = "not-a-version; password=backup-secret";
    let thrown: unknown;
    try {
      await importAll({ version: attackerValue, tables: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BackupValidationError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("Unsupported backup version unknown");
    expect((thrown as Error).message).not.toContain(attackerValue);
    expect((thrown as Error).message).not.toContain("backup-secret");
  });
});