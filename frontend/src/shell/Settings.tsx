import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, createUser, listUsers, type AppInfo, type UserAccount } from "../shared/api";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusMessage } from "../shared/ui/StatusMessage";
import { useAsync } from "../shared/useAsync";
import pkg from "../../package.json";
import { DataManagementPanel } from "./DataManagementPanel";
import { useAuth } from "./AuthContext";
import "./settings.css";

/** Settings sections retain drafts after their first visit. */
export function Settings({ apps = [] }: { apps?: AppInfo[] }) {
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [params] = useSearchParams();
  const requested = params.get("section");
  const section = requested === "data" || requested === "webdav" || (requested === "users" && admin) ? requested : "general";
  const [visited, setVisited] = useState<Set<string>>(() => new Set([section]));
  useEffect(() => { setVisited((previous) => previous.has(section) ? previous : new Set([...previous, section])); }, [section]);
  const enabled = apps.filter((app) => app.status === "enabled").length;
  const sections = [{ id: "general", label: "General", detail: "Platform overview" }, { id: "data", label: "Data", detail: "Export and import" }, { id: "webdav", label: "WebDAV", detail: "Cloud backups" }, ...(admin ? [{ id: "users", label: "Users", detail: "Account management" }] : [])];
  function sectionUrl(id: string) { const next = new URLSearchParams(params); next.set("section", id); return `?${next}`; }
  return (
    <div className="page page--detail settings-page" data-app="settings">
      <header className="page-header">
        <h1 className="page-header__title">Settings</h1>
        <p className="page-header__subtitle">Manage your platform, data and backups</p>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, detail }) => <Link key={id} to={sectionUrl(id)} aria-label={label} aria-current={section === id ? "page" : undefined} className={`px-button px-button--${section === id ? "primary" : "secondary"} px-button--md settings-nav__link`}>
            <span>{label}</span><small>{detail}</small>
          </Link>)}
        </nav>
        <div className="settings-content">
          <div hidden={section !== "general"}>
            <PixelWindow title="System" icon="settings">
              <dl className="px-deflist">
                <div><dt>Platform</dt><dd>PersonalPlatform</dd></div>
                <div><dt>Frontend</dt><dd>v{pkg.version}</dd></div>
                <div><dt>Apps</dt><dd>{apps.length} installed · {enabled} enabled</dd></div>
                <div><dt>Theme</dt><dd>Light (Pixel)</dd></div>
              </dl>
              <p className="settings-hint">Manage installed apps in the <Link to="/apps">App Center</Link>.</p>
            </PixelWindow>
            <PixelWindow title="Your settings" icon="file">
              <p>Use Data to export or merge a backup. Set up cloud backups and automatic schedules in WebDAV.</p>
              {admin && <p>Create and manage accounts in Users.</p>}
            </PixelWindow>
          </div>
          {(visited.has("data") || visited.has("webdav") || section === "data" || section === "webdav") && <DataManagementPanel section={section === "data" || section === "webdav" ? section : null} />}
          {admin && (visited.has("users") || section === "users") && <div hidden={section !== "users"}><UsersPanel /></div>}
        </div>
      </div>
    </div>
  );
}

/** Admin-only account management (AUTH-5): list + create regular users. */
function UsersPanel() {
  const users = useAsync<UserAccount[]>(listUsers, []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (busy) return;
    setFormError(null);
    setBusy(true);
    try {
      await createUser({
        username: username.trim(),
        password,
        displayName: displayName.trim() || null,
      });
      setUsername("");
      setPassword("");
      setDisplayName("");
      users.reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError(error instanceof Error ? error.message : "Could not create the user.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <PixelWindow title="Users" icon="settings">
      {users.loading ? (
        <p className="muted">Loading accounts…</p>
      ) : users.error ? (
        /forbidden|403/i.test(users.error) ? (
          <p className="muted">Account management requires an administrator session.</p>
        ) : (
          <StatusMessage tone="error">
            <p>Could not load users: {users.error}</p>
            <PixelButton variant="secondary" onClick={users.reload}>
              Retry
            </PixelButton>
          </StatusMessage>
        )
      ) : (
        <>
          <div className="data-management__table-wrap"><table className="user-panel__table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.displayName ?? account.username}{" "}
                    <span className="muted">@{account.username}</span>
                  </td>
                  <td>{account.role}</td>
                  <td>{account.status}</td>
                  <td>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <form
            className="user-panel__form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <span className="user-panel__field">
              <label htmlFor="new-user-username">Username</label>
              <PixelInput
                id="new-user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="new-user"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </span>
            <span className="user-panel__field">
              <label htmlFor="new-user-display">Display name (optional)</label>
              <PixelInput
                id="new-user-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                autoComplete="off"
                maxLength={100}
              />
            </span>
            <span className="user-panel__field">
              <label htmlFor="new-user-password">Password (min 8 chars)</label>
              <PixelInput
                id="new-user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="initial password"
                autoComplete="new-password"
                required
              />
            </span>
            <PixelButton type="submit" variant="secondary" disabled={busy}>
              {busy ? "Creating…" : "Create User"}
            </PixelButton>
          </form>
          {formError ? (
            <StatusMessage tone="error">
              <p>{formError}</p>
            </StatusMessage>
          ) : null}
        </>
      )}
    </PixelWindow>
  );
}
