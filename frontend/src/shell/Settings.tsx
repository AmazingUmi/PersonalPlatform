import { localizeError } from "../shared/localizeError";
import { useI18n } from "../shared/i18n";
import { HelpPopover } from "../shared/ui/HelpPopover";
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
  const { t, language, setLanguage } = useI18n();
  const { user } = useAuth();
  const admin = user?.role === "admin";
  const [params] = useSearchParams();
  const requested = params.get("section");
  const section = requested === "data" || requested === "webdav" || (requested === "users" && admin) ? requested : "general";
  const [visited, setVisited] = useState<Set<string>>(() => new Set([section]));
  useEffect(() => { setVisited((previous) => previous.has(section) ? previous : new Set([...previous, section])); }, [section]);
  const enabled = apps.filter((app) => app.status === "enabled").length;
  const sections = [{ id: "general", label: t("General", "概览") }, { id: "data", label: t("Data", "数据") }, { id: "webdav", label: "WebDAV" }, ...(admin ? [{ id: "users", label: t("Users", "用户") }] : [])];
  function sectionUrl(id: string) { const next = new URLSearchParams(params); next.set("section", id); return `?${next}`; }
  return (
    <div className="page page--detail settings-page" data-app="settings">
      <header className="page-header">
        <h1 className="page-header__title">{t("Settings", "设置")}</h1>
        <HelpPopover label={t("Settings", "设置")}>{t("Manage your platform, data and backups", "管理平台、数据与备份。")}</HelpPopover>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t("Settings sections", "设置分区")}>
          {sections.map(({ id, label }) => <Link key={id} to={sectionUrl(id)} aria-label={label} aria-current={section === id ? "page" : undefined} className={`px-button px-button--${section === id ? "primary" : "secondary"} px-button--md settings-nav__link`}>
            <span>{label}</span>
          </Link>)}
        </nav>
        <div className="settings-content">
          <div hidden={section !== "general"}>
            <PixelWindow title={t("System", "系统")} icon="settings">
              <dl className="px-deflist">
                <div><dt>{t("Platform", "平台")}</dt><dd>PersonalPlatform</dd></div>
                <div><dt>{t("Frontend", "前端")}</dt><dd>v{pkg.version}</dd></div>
                <div><dt>{t("Apps", "应用")}</dt><dd>{apps.length} {t("installed ·", "个已安装 ·")} {enabled} {t("enabled", "已启用")}</dd></div>
                <div><dt>{t("Theme", "主题")}</dt><dd>{t("Light (Pixel)", "浅色（像素）")}</dd></div>
              </dl>
              <HelpPopover label={t("App management", "应用管理")}>{t("Manage installed apps in the", "管理已安装应用：")} <Link to="/apps">{t("App Center", "应用中心")}</Link>.</HelpPopover>
            </PixelWindow>
            <PixelWindow title="Language / 语言" icon="settings" actions={<HelpPopover label={t("Language", "语言")}>
              {t("The language is saved in this browser. Switching languages keeps your unsaved work and does not change the platform time zone.", "语言选择保存在当前浏览器。切换语言保留未保存内容，不改变平台时区。")}
            </HelpPopover>}>
              <label className="data-management__field" htmlFor="interface-language">{t("Interface language", "界面语言")}
                <select id="interface-language" className="px-input" aria-label="Language / 语言" value={language} onChange={event => setLanguage(event.target.value as "en" | "zh")}>
                  <option value="en">English</option><option value="zh">简体中文</option>
                </select>
              </label>
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
  const { t, locale, language } = useI18n();
  const users = useAsync<UserAccount[]>(listUsers, []);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<unknown>(null);
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
        setFormError(error);
      } else {
        setFormError(error instanceof Error ? error.message : "Could not create the user.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <PixelWindow title={t("Users", "用户")} icon="settings">
      {users.loading ? (
        <p className="muted">{t("Loading accounts…", "正在加载账号…")}</p>
      ) : users.error ? (
        /forbidden|403/i.test(users.error) ? (
          <p className="muted">{t("Account management requires an administrator session.", "账号管理需要管理员权限。")}</p>
        ) : (
          <StatusMessage tone="error">
            <p>{t("Could not load users:", "无法加载用户：")} {users.error}</p>
            <PixelButton variant="secondary" onClick={users.reload}>{t("Retry", "重试")} </PixelButton>
          </StatusMessage>
        )
      ) : (
        <>
          <div className="data-management__table-wrap"><table className="user-panel__table">
            <thead>
              <tr>
                <th>{t("User", "用户")}</th>
                <th>{t("Role", "角色")}</th>
                <th>{t("Status", "状态")}</th>
                <th>{t("Last login", "最近登录")}</th>
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((account) => (
                <tr key={account.id}>
                  <td>
                    {account.displayName ?? account.username}{" "}
                    <span className="muted">@{account.username}</span>
                  </td>
                  <td>{account.role === "admin" ? t("admin", "管理员") : t("user", "用户")}</td>
                  <td>{({ active: t("active", "正常"), disabled: t("disabled", "停用"), pending: t("pending", "待激活") } as Record<string, string>)[account.status] ?? account.status}</td>
                  <td>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString(locale) : "—"}</td>
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
              <label htmlFor="new-user-username">{t("Username", "用户名")}</label>
              <PixelInput
                id="new-user-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("new-user", "新用户名")}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </span>
            <span className="user-panel__field">
              <label htmlFor="new-user-display">{t("Display name (optional)", "显示名称（可选）")}</label>
              <PixelInput
                id="new-user-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("Display name", "显示名称")}
                autoComplete="off"
                maxLength={100}
              />
            </span>
            <span className="user-panel__field">
              <label htmlFor="new-user-password">{t("Password (min 8 chars)", "密码（至少 8 位）")}</label>
              <PixelInput
                id="new-user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("initial password", "初始密码")}
                autoComplete="new-password"
                required
              />
            </span>
            <PixelButton type="submit" variant="secondary" disabled={busy}>
              {busy ? t("Creating…", "正在创建…") : t("Create User", "创建用户")}
            </PixelButton>
          </form>
          {formError ? (
            <StatusMessage tone="error">
              <p>{localizeError(formError, language)}</p>
            </StatusMessage>
          ) : null}
        </>
      )}
    </PixelWindow>
  );
}
