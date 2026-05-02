import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { SessionUser } from "./types";

type AuthContextValue = {
  user: SessionUser | null;
  loading: boolean;
  // True until both /auth/me and /auth/setup-status have settled.
  needsSetup: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  // Performs first-time setup, claiming the seeded admin account with the
  // chosen password and returning an authenticated session.
  setup: (password: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>("/auth/me");
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        setUser(null);
      }
    }
  }, []);

  const refreshSetupStatus = useCallback(async () => {
    try {
      const status = await api.get<{ needsSetup: boolean }>("/auth/setup-status");
      setNeedsSetup(!!status.needsSetup);
    } catch {
      // Network or server failure: assume setup is not needed so we fall
      // back to the standard login screen and surface the real auth error
      // there instead of trapping the user on /setup.
      setNeedsSetup(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([refresh(), refreshSetupStatus()]).finally(() => setLoading(false));
  }, [refresh, refreshSetupStatus]);

  const login = useCallback(
    async (username: string, password: string) => {
      const me = await api.post<SessionUser>("/auth/login", { username, password });
      setUser(me);
    },
    [],
  );

  const setup = useCallback(
    async (password: string) => {
      try {
        const me = await api.post<SessionUser>("/auth/setup", { password });
        setUser(me);
        setNeedsSetup(false);
      } catch (err) {
        // 409 means another actor (or a previous tab) already claimed the
        // admin account. Re-fetch setup-status so the UI flips to the
        // login screen instead of stranding the user on /setup forever.
        if (err instanceof ApiError && err.status === 409) {
          await refreshSetupStatus();
        }
        throw err;
      }
    },
    [refreshSetupStatus],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, needsSetup, login, logout, refresh, setup }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
