import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../shared/api";
import { useAuth } from "./AuthContext";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelIcon } from "../shared/ui/PixelIcon";
import { PixelInput } from "../shared/ui/PixelInput";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";

/**
 * System login (AUTH-5) — the platform entry in the same pixel/terminal
 * language as the shell. Credentials go to the HttpOnly session cookie via
 * POST /api/core/auth/login; nothing is persisted client-side.
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Preserve the destination the user was trying to reach.
  const from =
    typeof location.state === "object" && location.state !== null && "from" in location.state
      ? String((location.state as { from?: unknown }).from ?? "/")
      : "/";

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(username, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Access denied — unknown user or wrong password.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts — wait a moment and try again.");
      } else {
        setError(err instanceof Error ? err.message : "Login failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page page--boot">
      <PixelWindow title="System Login" icon="logo">
        <p className="login-brand">
          <PixelIcon name="logo" size={20} className="login-brand__icon" />
          <span>
            Personal Platform <span className="login-brand__sigil">:: AUTH REQUIRED</span>
          </span>
        </p>
        <form className="login-form" onSubmit={(e) => void onSubmit(e)}>
          <label className="login-field">
            <span className="login-field__label">user@platform ~ $ whoami</span>
            <PixelInput
              name="username"
              autoComplete="username"
              spellCheck={false}
              required
              maxLength={64}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              aria-label="Username"
            />
          </label>
          <label className="login-field">
            <span className="login-field__label">passwd@platform ~ $ ******</span>
            <PixelInput
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              aria-label="Password"
            />
          </label>
          {error ? (
            <StatusMessage tone="error">
              <p>{error}</p>
            </StatusMessage>
          ) : null}
          <div className="login-actions">
            {busy ? (
              <LoadingState label="Authenticating…" />
            ) : (
              <PixelButton type="submit" variant="primary">
                Log In ▸
              </PixelButton>
            )}
          </div>
        </form>
        <p className="login-hint">Session cookie only · HttpOnly · nothing stored in the browser</p>
      </PixelWindow>
    </div>
  );
}
