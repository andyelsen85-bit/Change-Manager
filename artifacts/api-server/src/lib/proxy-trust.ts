import { isIP } from "node:net";

const DEFAULT_PROXY_HOPS = 1;
const MAX_PROXY_HOPS = 8;

export type ProxyTrustSetting = number | string[];

function validateCidr(value: string): string {
  const slash = value.lastIndexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(
      `TRUSTED_PROXY_CIDRS contains "${value}", which must be an IP address with a CIDR prefix (for example 10.0.0.0/8).`,
    );
  }
  const address = value.slice(0, slash);
  const prefixRaw = value.slice(slash + 1);
  const family = isIP(address);
  if (family === 0 || !/^\d+$/.test(prefixRaw)) {
    throw new Error(`TRUSTED_PROXY_CIDRS contains invalid CIDR "${value}".`);
  }
  const prefix = Number(prefixRaw);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`TRUSTED_PROXY_CIDRS contains "${value}" with a prefix outside /0-/${maxPrefix}.`);
  }
  return value;
}

/**
 * Express's numeric trust setting is deliberately the default: the expected
 * topology has exactly one reverse-proxy hop (nginx). Deployments with a
 * known private proxy network can opt into an explicit CIDR list instead.
 * Never use `true`, which trusts attacker-controlled X-Forwarded-* headers.
 */
export function getProxyTrustSetting(
  env: NodeJS.ProcessEnv = process.env,
): ProxyTrustSetting {
  const cidrRaw = env["TRUSTED_PROXY_CIDRS"]?.trim() ?? "";
  const hopsRaw = env["TRUST_PROXY_HOPS"]?.trim() ?? "";
  if (cidrRaw && hopsRaw) {
    throw new Error("Set only one of TRUST_PROXY_HOPS or TRUSTED_PROXY_CIDRS.");
  }
  if (cidrRaw) {
    const cidrs = cidrRaw.split(",").map((value) => value.trim()).filter(Boolean);
    if (cidrs.length === 0) {
      throw new Error("TRUSTED_PROXY_CIDRS must contain at least one CIDR.");
    }
    return cidrs.map(validateCidr);
  }
  if (!hopsRaw) return DEFAULT_PROXY_HOPS;
  if (!/^(?:0|[1-9]\d*)$/.test(hopsRaw)) {
    throw new Error("TRUST_PROXY_HOPS must be a non-negative integer.");
  }
  const hops = Number(hopsRaw);
  if (!Number.isSafeInteger(hops) || hops > MAX_PROXY_HOPS) {
    throw new Error(`TRUST_PROXY_HOPS must be between 0 and ${MAX_PROXY_HOPS}.`);
  }
  return hops;
}