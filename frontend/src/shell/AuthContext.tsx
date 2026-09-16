import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  UNAUTHORIZED_EVENT,
  type AuthUser,
} from "../shared/api";

/**
 * Session bootstrap + 401 handling (AUTH-5).
 *
 * Startup: GET /api/core/auth/me → 200 renders the shell, 401 routes to
 * /login. Any later 401 from an app/core endpoint (session expired, admin
 * revoked) dispatches UNAUTHORIZED_EVENT and flips the app back to the login
 * page — the session secret itself lives only in the HttpOnly cookie.
 */
export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Login with username/password; resolves with the user view on success. */
  signIn(username: string, password: string): Promise<AuthUser>;
  /** Invalidate the session server-side, then drop the local state. */
  signOut(): Promise<void>;
  /** Refresh the user view from /me (e.g. after window refocus). */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    fetchMe()
      .then((me) => {
        if (!mounted.current) return;
        if (me) {
          setUser(me);
          setStatus("authenticated");
        } else {
          setUser(null);
          setStatus("anonymous");
        }
      })
      .catch(() => {
        // Backend unreachable at boot: treat as logged out — the login form
        // will surface the real connectivity error on submit.
        if (mounted.current) setStatus("anonymous");
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const onUnauthorized = (): void => {
      setUser(null);
      setStatus("anonymous");
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signIn = useCallback(async (username: string, password: string): Promise<AuthUser> => {
    const me = await apiLogin(username, password);
    setUser(me);
    setStatus("authenticated");
    return me;
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await apiLogout().catch(() => undefined); // cookie cleared server-side best-effort
    setUser(null);
    setStatus("anonymous");
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const me = await fetchMe().catch(() => null);
    if (!mounted.current) return;
    if (me) {
      setUser(me);
      setStatus("authenticated");
    } else {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signOut, refresh }),
    [status, user, signIn, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
