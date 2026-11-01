import { localizeError } from "../shared/localizeError";
import { useI18n } from "../shared/i18n";
import { HelpPopover } from "../shared/ui/HelpPopover";
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
  const { t, language } = useI18n();
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
      <PixelWindow title={t("System Login", "登录平台")} icon="logo" titleHelp={<HelpPopover label={t("Signing in", "登录说明")}>{t("HttpOnly session cookie · your password is not stored by this app in the browser", "登录凭据使用 HttpOnly 会话 Cookie；密码不会保存在浏览器中。")}</HelpPopover>}>
        <p className="login-brand">
          <PixelIcon name="logo" size={20} className="login-brand__icon" />
          <span>
            Personal Platform <span className="login-brand__sigil">{t(":: AUTH REQUIRED", ":: 需要登录")}</span>
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
              placeholder={t("username", "用户名")}
              aria-label={t("Username", "用户名")}
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
              placeholder={t("password", "密码")}
              aria-label={t("Password", "密码")}
            />
          </label>
          {error ? (
            <StatusMessage tone="error">
              <p>{localizeError(error, language)}</p>
            </StatusMessage>
          ) : null}
          <div className="login-actions">
            {busy ? (
              <LoadingState label={t("Authenticating…", "正在验证…")} />
            ) : (
              <PixelButton type="submit" variant="primary">{t("Log In ▸", "登录 ▸")} </PixelButton>
            )}
          </div>
        </form>
      </PixelWindow>
    </div>
  );
}
