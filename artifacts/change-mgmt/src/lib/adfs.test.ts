import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import {
  clearAdfsLoginPreference,
  getReturnToFromSearch,
  hasAdfsAutoLoginAttempt,
  isAdfsReady,
  markAdfsAutoLoginAttempt,
  shouldStartAdfsAutoLogin,
  validateLocalReturnTo,
} from "./adfs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("frontend AD FS return destinations", () => {
  it("preserves local paths, query strings, and fragments", () => {
    expect(
      getReturnToFromSearch("?returnTo=%2Frequests%2F456%3Ftab%3Dhistory%23comments"),
    ).toBe("/requests/456?tab=history#comments");
    // A percent-encoded slash in a query value is data, not a path redirect.
    expect(
      getReturnToFromSearch("?returnTo=%2Fchanges%3Fnext%3D%252Ffoo%23history"),
    ).toBe("/changes?next=%2Ffoo#history");
    expect(validateLocalReturnTo("/changes/123?tab=history#comments")).toBe(
      "/changes/123?tab=history#comments",
    );
  });

  it.each([
    "?returnTo=https%3A%2F%2Fevil.example%2Fsteal",
    "?returnTo=%2F%2Fevil.example%2Fsteal",
    "?returnTo=%2F%255c%255cevil.example",
    "?returnTo=%2F%250d%250aX-Injected%3A%20yes",
    "?returnTo=%E0%A4%A",
  ])("falls back to / for encoded redirect attack %s", (search) => {
    expect(getReturnToFromSearch(search)).toBe("/");
  });

  it("rejects direct unsafe local destinations", () => {
    expect(validateLocalReturnTo("https://evil.example")).toBe("/");
    expect(validateLocalReturnTo("//evil.example")).toBe("/");
    expect(validateLocalReturnTo("/\\evil.example")).toBe("/");
    expect(validateLocalReturnTo("/changes/%2F%2Fevil")).toBe("/");
    expect(validateLocalReturnTo("/changes/%0d%0aInjected")).toBe("/");
  });
});

describe("frontend AD FS automatic login flow", () => {
  const ready = { enabled: true, configured: true, displayName: "Sign in with AD FS" };

  it("requires enabled and configured API flags before showing the ready flow", () => {
    const search = "?returnTo=%2Fchanges%2F123";
    expect(isAdfsReady(ready)).toBe(true);
    expect(isAdfsReady({ ...ready, enabled: false })).toBe(false);
    expect(isAdfsReady({ ...ready, configured: false })).toBe(false);
    expect(shouldStartAdfsAutoLogin(ready, search, true, false)).toBe(true);
    expect(shouldStartAdfsAutoLogin({ ...ready, enabled: false }, search, true, false)).toBe(false);
    expect(shouldStartAdfsAutoLogin({ ...ready, configured: false }, search, true, false)).toBe(false);
  });

  it("starts only once per tab and clears the attempt on explicit logout", () => {
    const storage = {
      value: null as string | null,
      getItem: vi.fn(() => storage.value),
      setItem: vi.fn((_key: string, value: string) => {
        storage.value = value;
      }),
      removeItem: vi.fn(() => {
        storage.value = null;
      }),
    };
    const documentStub = { cookie: "cm_login_method=adfs" };
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.stubGlobal("document", documentStub);

    expect(shouldStartAdfsAutoLogin(ready, "?returnTo=%2Fchanges%2F123", true, hasAdfsAutoLoginAttempt())).toBe(true);
    markAdfsAutoLoginAttempt();
    expect(hasAdfsAutoLoginAttempt()).toBe(true);
    expect(shouldStartAdfsAutoLogin(ready, "?returnTo=%2Fchanges%2F123", true, hasAdfsAutoLoginAttempt())).toBe(false);

    clearAdfsLoginPreference();
    expect(documentStub.cookie).toContain("Max-Age=0");
    expect(storage.removeItem).toHaveBeenCalledWith("change-it:adfs-auto-login-attempted");
    expect(hasAdfsAutoLoginAttempt()).toBe(false);
  });
});

describe("frontend API helper settings contract", () => {
  it("sends credentials and the CSRF token for AD FS settings mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ enabled: true }),
    });
    vi.stubGlobal("document", { cookie: "cm_csrf=csrf-token-123" });
    vi.stubGlobal("fetch", fetchMock);

    await api.put("/settings/adfs", {
      enabled: true,
      displayName: "Sign in with AD FS",
      clientSecret: null,
      caCertPem: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settings/adfs");
    expect(init.method).toBe("PUT");
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token-123");
    expect(JSON.parse(String(init.body))).toMatchObject({
      enabled: true,
      clientSecret: null,
      caCertPem: null,
    });
  });
});