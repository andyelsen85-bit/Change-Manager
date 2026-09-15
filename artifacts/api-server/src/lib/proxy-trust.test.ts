import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getProxyTrustSetting } from "./proxy-trust";
import { requestIp } from "./login-throttle";

describe("reverse-proxy trust and throttle client IP", () => {
  it("defaults to exactly one trusted proxy hop", () => {
    expect(getProxyTrustSetting({})).toBe(1);
    expect(getProxyTrustSetting({ TRUST_PROXY_HOPS: "0" })).toBe(0);
  });

  it("accepts validated proxy CIDRs and rejects ambiguous/invalid settings", () => {
    expect(getProxyTrustSetting({ TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 2001:db8::/32" })).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
    expect(() => getProxyTrustSetting({ TRUSTED_PROXY_CIDRS: "not-an-ip/24" })).toThrow(
      /invalid CIDR/i,
    );
    expect(() =>
      getProxyTrustSetting({ TRUST_PROXY_HOPS: "1", TRUSTED_PROXY_CIDRS: "10.0.0.0/8" }),
    ).toThrow(/only one/i);
  });

  it("does not read the raw forwarded header as a throttle key", () => {
    const request = {
      ip: "198.51.100.24",
      headers: { "x-forwarded-for": "203.0.113.99, 198.51.100.24" },
      socket: { remoteAddress: "10.0.0.2" },
    };
    expect(requestIp(request as never)).toBe("198.51.100.24");
  });

  it("has nginx replace, rather than append to, client-supplied X-Forwarded-For", () => {
    const nginxEntrypoint = readFileSync(new URL("../../../../docker/entrypoint-web.sh", import.meta.url), "utf8");
    expect(nginxEntrypoint).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(nginxEntrypoint).not.toContain("$proxy_add_x_forwarded_for");
  });
});