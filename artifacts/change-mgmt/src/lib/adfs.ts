import { apiUrl } from "./api";

export const ADFS_AUTO_LOGIN_STORAGE_KEY = "change-it:adfs-auto-login-attempted";
const LOGIN_METHOD_COOKIE = "cm_login_method";

export type AdfsPublicConfig = {
  enabled: boolean;
  configured: boolean;
  displayName?: string;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MALFORMED_ESCAPE = /%(?![0-9a-f]{2})/i;
const ENCODED_UNSAFE_PATH_CHARACTER = /%(?:2f|00|0a|0d|09)/i;
const DOUBLE_ENCODED_UNSAFE_PATH_CHARACTER = /%25(?:2f|00|0a|0d|09)/i;
const ENCODED_UNSAFE_CHARACTER = /%(?:5c|00|0a|0d|09)/i;
const DOUBLE_ENCODED_UNSAFE_CHARACTER = /%25(?:5c|00|0a|0d|09)/i;

function hasUnsafeEncodedCharacters(value: string): boolean {
  const pathEnd = value.search(/[?#]/);
  const path = pathEnd >= 0 ? value.slice(0, pathEnd) : value;
  return (
    ENCODED_UNSAFE_PATH_CHARACTER.test(path) ||
    DOUBLE_ENCODED_UNSAFE_PATH_CHARACTER.test(path) ||
    ENCODED_UNSAFE_CHARACTER.test(value) ||
    DOUBLE_ENCODED_UNSAFE_CHARACTER.test(value)
  );
}

/**
 * Only return destinations within this application. The value is deliberately
 * returned unchanged (rather than normalized by URL) so query strings and
 * fragments survive the complete authentication round trip.
 */
export function validateLocalReturnTo(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "/";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    CONTROL_CHARACTERS.test(value) ||
    MALFORMED_ESCAPE.test(value) ||
    hasUnsafeEncodedCharacters(value) ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return "/";
  }

  try {
    const parsed = new URL(value, "https://change-it.invalid");
    if (parsed.origin !== "https://change-it.invalid" || !parsed.pathname.startsWith("/")) return "/";
  } catch {
    return "/";
  }
  return value;
}

/**
 * Decode an individual returnTo query value strictly. URLSearchParams is
 * intentionally not used here because it silently accepts malformed percent
 * escapes, which makes encoded redirect attacks difficult to reject.
 */
export function decodeLocalReturnTo(rawValue: string | null | undefined): string {
  if (typeof rawValue !== "string" || rawValue.length === 0 || MALFORMED_ESCAPE.test(rawValue)) return "/";
  try {
    return validateLocalReturnTo(decodeURIComponent(rawValue.replace(/\+/g, " ")));
  } catch {
    return "/";
  }
}

function rawQueryParameter(search: string, name: string): string | null {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair;
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : "";
    if (MALFORMED_ESCAPE.test(rawKey)) continue;
    try {
      if (decodeURIComponent(rawKey.replace(/\+/g, " ")) === name) return rawValue;
    } catch {
      // Ignore malformed unrelated parameters; an invalid returnTo still
      // resolves to the safe root destination below.
    }
  }
  return null;
}

export function getReturnToFromSearch(search: string): string {
  return decodeLocalReturnTo(rawQueryParameter(search, "returnTo"));
}

export function hasReturnToParameter(search: string): boolean {
  return rawQueryParameter(search, "returnTo") !== null;
}

export function isAdfsReady(config: AdfsPublicConfig | null | undefined): boolean {
  return !!config?.enabled && !!config?.configured;
}

export function shouldStartAdfsAutoLogin(
  config: AdfsPublicConfig | null | undefined,
  search: string,
  loginPreference: boolean,
  autoLoginAttempted: boolean,
): boolean {
  return isAdfsReady(config) && hasReturnToParameter(search) && loginPreference && !autoLoginAttempted;
}

export function currentLocalLocation(): string {
  if (typeof window === "undefined") return "/";
  return validateLocalReturnTo(`${window.location.pathname}${window.location.search}${window.location.hash}`);
}

export function readCookie(name: string): string | null {
  if (typeof document === "undefined" || !document.cookie) return null;
  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1));
    } catch {
      return entry.slice(separator + 1);
    }
  }
  return null;
}

export function hasAdfsLoginPreference(): boolean {
  return readCookie(LOGIN_METHOD_COOKIE) === "adfs";
}

export function clearAdfsLoginPreference(): void {
  if (typeof document !== "undefined") {
    document.cookie = `${LOGIN_METHOD_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
  clearAdfsAutoLoginAttempt();
}

export function hasAdfsAutoLoginAttempt(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(ADFS_AUTO_LOGIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markAdfsAutoLoginAttempt(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ADFS_AUTO_LOGIN_STORAGE_KEY, "1");
  } catch {
    // Session storage can be unavailable in privacy-restricted contexts. The
    // cookie and server-side state still protect the OIDC flow.
  }
}

export function clearAdfsAutoLoginAttempt(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(ADFS_AUTO_LOGIN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function adfsStartUrl(returnTo: string): string {
  const safeReturnTo = validateLocalReturnTo(returnTo);
  return `${apiUrl("/auth/adfs/start")}?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function startAdfsLogin(returnTo: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(adfsStartUrl(returnTo));
}