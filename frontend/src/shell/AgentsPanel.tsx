import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type AppInfo, type AuthUser } from "../shared/api";
import { useI18n, type Translate } from "../shared/i18n";
import { appName } from "../shared/localizedMetadata";
import { SESSION_ENDING_EVENT } from "../shared/sync";
import { useAsync } from "../shared/useAsync";
import { ConfirmDialog } from "../shared/ui/ConfirmDialog";
import { EmptyState } from "../shared/ui/EmptyState";
import { LoadingState } from "../shared/ui/LoadingState";
import { PixelButton } from "../shared/ui/PixelButton";
import { PixelInput } from "../shared/ui/PixelInput";
import { PixelWindow } from "../shared/ui/PixelWindow";
import { StatusChip } from "../shared/ui/StatusChip";
import { StatusMessage } from "../shared/ui/StatusMessage";

const agentsUrl = "/api/core/agents";
const allScopes = ["read", "write", "delete"] as const;
type Scope = typeof allScopes[number];

interface Permissions {
  scopes: Scope[];
  allowedApps: string[];
}

interface PermissionDraft extends Permissions {
  expiry: string;
}

interface AgentView {
  id: string;
  name: string;
  description: string;
  tokenPrefix: string;
  status: "active" | "revoked";
  requiresExplicitActor: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface GrantView extends Permissions {
  id: string;
  agentId: string;
  agentName: string;
  agentStatus: "active" | "revoked";
  ownerName: string;
  expiresAt: string | null;
  status: "active" | "revoked";
}

interface PairingPreview extends Permissions {
  agentName: string;
  ownerName: string;
  expiresAt: string;
}

interface AuditItem {
  id: string;
  agentName: string;
  appId: string;
  toolName: string;
  actionKind: "write" | "delete";
  resourceId: string | null;
  status: "ok" | "replayed" | "conflict" | "denied" | "error";
  errorCode: string | null;
  createdAt: string;
}

type AgentList = { owned: AgentView[]; grants: GrantView[] };
type AuditPage = { items: AuditItem[]; nextCursor: string | null };
type Secret =
  | { kind: "token"; agent: AgentView; token: string }
  | { kind: "pairing"; agent: AgentView; code: string; expiresAt: string };
type Editor =
  | { kind: "pairing"; agent: AgentView; permissions: PermissionDraft }
  | { kind: "grant"; grant: GrantView; permissions: PermissionDraft };
type Confirmation = { title: string; message: string; action: () => Promise<void> };

function submitJson<T>(path: string, method: "POST" | "PATCH", data: unknown): Promise<T> {
  return api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}

function emptyPermissions(): PermissionDraft {
  return { scopes: [], allowedApps: [], expiry: "" };
}

function expiryInputValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function grantData({ scopes, allowedApps, expiry }: PermissionDraft) {
  return { scopes, allowedApps, ...(expiry && { expiresAt: new Date(expiry).toISOString() }) };
}

function scopeText(scope: Scope, t: Translate): string {
  switch (scope) {
    case "read": return t("Read", "读取");
    case "write": return t("Write", "写入");
    case "delete": return t("Delete", "删除");
  }
}

function changeSelection<T>(selected: T[], value: T, checked: boolean): T[] {
  return checked ? [...selected, value] : selected.filter(item => item !== value);
}

function grantStatus(grant: GrantView): "active" | "expired" | "revoked" {
  if (grant.agentStatus === "revoked" || grant.status === "revoked") return "revoked";
  return grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now() ? "expired" : "active";
}

function inspectorCommand(username: string, token = "<token>"): string {
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const url = window.location.origin + "/api/agent/mcp";
  return [
    "npx @modelcontextprotocol/inspector@2.16.0 --cli",
    quote(url),
    "--transport http --protocol-era legacy --method tools/list --header",
    quote("Authorization: Bearer " + token),
    quote("X-PP-Acting-User: " + username),
  ].join(" ");
}

function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "pairing_unavailable": return t("This pairing code is unavailable. Ask for a fresh code.", "此配对码不可用。请索取新配对码。");
      case "grant_already_active": return t("Your account already has an active grant for this Agent.", "当前账号已有此 Agent 的有效授权。");
      case "grant_expansion": return t("An existing grant can only be narrowed. To authorize more access, revoke it and create a new grant.", "现有授权只能缩减。如需增加权限，请撤销后重新授权。");
      case "agent_revoked": return t("This Agent has been revoked.", "此 Agent 已撤销。");
      case "agent_rate_limited": return t("Too many pairing requests. Try again shortly.", "配对请求过多，请稍后再试。");
      case "validation_error": return t("Check the submitted Agent settings.", "请检查提交的 Agent 设置。");
      case "not_found": return t("This Agent or grant is no longer available.", "此 Agent 或授权已不可用。");
    }
  }
  return t("The Agent request could not be completed. Try again.", "无法完成 Agent 请求，请重试。");
}

function PermissionFields({ draft, change, apps, scopeOptions = allScopes, appLabel, disabled, expiry, maximumExpiry }: {
  draft: PermissionDraft;
  change: (draft: PermissionDraft) => void;
  apps: string[];
  scopeOptions?: readonly Scope[];
  appLabel: (id: string) => string;
  disabled: boolean;
  expiry: boolean;
  maximumExpiry?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="agents-panel__permissions">
      <fieldset disabled={disabled}>
        <legend>{t("Scopes", "权限范围")}</legend>
        <div className="agents-panel__choices">
          {scopeOptions.map(scope => <label key={scope}>
            <input type="checkbox" checked={draft.scopes.includes(scope)} onChange={event => {
              change({ ...draft, scopes: changeSelection(draft.scopes, scope, event.target.checked) });
            }} /> {scopeText(scope, t)}
          </label>)}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>{t("Allowed apps", "允许访问的应用")}</legend>
        <div className="agents-panel__choices">
          {apps.map(app => <label key={app}>
            <input type="checkbox" checked={draft.allowedApps.includes(app)} onChange={event => {
              change({ ...draft, allowedApps: changeSelection(draft.allowedApps, app, event.target.checked) });
            }} /> {appLabel(app)}
          </label>)}
          {apps.length === 0 && <span>{t("No apps available.", "没有可选应用。")}</span>}
        </div>
      </fieldset>
      {expiry && <label className="agents-panel__field">
        {t("Grant expires", "授权到期时间")}
        <PixelInput type="datetime-local" value={draft.expiry} max={maximumExpiry} required={Boolean(maximumExpiry)}
          disabled={disabled} onChange={event => change({ ...draft, expiry: event.target.value })} />
      </label>}
    </div>
  );
}

export function AgentsPanel({ apps, user }: { apps: AppInfo[]; user: AuthUser }) {
  const { t, locale, language } = useI18n();
  const installed = apps.map(app => app.id);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [personal, setPersonal] = useState(emptyPermissions);
  const [inputCode, setInputCode] = useState("");
  const [approval, setApproval] = useState<{ code: string; preview: PairingPreview; permissions: PermissionDraft } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const pending = useRef(false);
  const ending = useRef(false);
  const agents = useAsync(() => api<AgentList>(agentsUrl), [], { retainOnReload: true });
  const cursor = cursors.at(-1);
  const audit = useAsync(() => api<AuditPage>(agentsUrl + "/audit?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")), [cursor]);

  useEffect(() => {
    const clearSecrets = () => {
      setSecret(null);
      setInputCode("");
      setApproval(null);
      setConfirmation(null);
    };
    const onSessionEnding = () => {
      ending.current = true;
      clearSecrets();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) clearSecrets();
    };
    window.addEventListener(SESSION_ENDING_EVENT, onSessionEnding);
    window.addEventListener("pagehide", clearSecrets);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener(SESSION_ENDING_EVENT, onSessionEnding);
      window.removeEventListener("pagehide", clearSecrets);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  function appLabel(id: string): string {
    return appName(id, apps.find(app => app.id === id)?.name ?? id, language);
  }

  function formatTime(value: string): string {
    return new Date(value).toLocaleString(locale);
  }

  function permissionSummary(selection: Permissions): string {
    const scopeSummary = selection.scopes.map(scope => scopeText(scope, t)).join(", ");
    const appSummary = selection.allowedApps.map(appLabel).join(", ");
    return scopeSummary + " · " + (appSummary || t("No apps", "没有应用"));
  }

  async function perform(action: () => Promise<void>): Promise<void> {
    if (pending.current || ending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    } finally {
      setConfirmation(null);
      setBusy(false);
      pending.current = false;
    }
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(t("Copied.", "已复制。"));
    } catch {
      setStatus(t("Copy unavailable. Select the displayed text to copy it.", "无法自动复制。请选择显示的文本后手动复制。"));
    }
  }

  function confirm(title: string, message: string, action: () => Promise<void>): void {
    setConfirmation({ title, message, action });
  }

  function revokeAgent(agent: AgentView): void {
    confirm(t("Revoke Agent", "撤销 Agent"),
      t(`Revoke ${agent.name} for everyone? Existing credentials, grants and pairing codes will no longer grant access.`,
        `对所有用户撤销 ${agent.name}？现有凭据、授权及配对码将失去访问权限。`), async () => {
        await api(agentsUrl + "/" + agent.id, { method: "DELETE" });
        if (secret?.agent.id === agent.id) setSecret(null);
        if (editor?.kind === "pairing" && editor.agent.id === agent.id) setEditor(null);
        setStatus(t("Agent revoked.", "Agent 已撤销。"));
        await agents.reload();
      });
  }

  function revokeGrant(grant: GrantView): void {
    confirm(t("Revoke grant", "撤销授权"),
      t(`Remove ${grant.agentName}'s access to your account?`, `移除 ${grant.agentName} 对您账号的访问权限？`), async () => {
        await api(agentsUrl + "/grants/" + grant.id, { method: "DELETE" });
        if (editor?.kind === "grant" && editor.grant.id === grant.id) setEditor(null);
        if (secret?.agent.id === grant.agentId) setSecret(null);
        setStatus(t("Grant revoked.", "授权已撤销。"));
        await agents.reload();
      });
  }

  function rotate(agent: AgentView): void {
    confirm(t("Rotate token", "轮换令牌"),
      t(`Replace the token for ${agent.name}? The previous token stops working and existing grants stay active.`,
        `更换 ${agent.name} 的令牌？旧令牌将失效，现有授权继续有效。`), async () => {
        const result = await api<{ agent: AgentView; token: string }>(agentsUrl + "/" + agent.id + "/rotate-token", { method: "POST" });
        if (!ending.current) setSecret({ kind: "token", ...result });
        await agents.reload();
      });
  }

  function openGrantEditor(grant: GrantView): void {
    setEditor({ kind: "grant", grant, permissions: { scopes: grant.scopes, allowedApps: grant.allowedApps, expiry: expiryInputValue(grant.expiresAt) } });
  }

  const showToken = secret?.kind === "token";
  let editing: ReactNode;
  if (editor) {
    const editingGrant = editor.kind === "grant";
    const permissions = editor.permissions;
    const heading = editingGrant ? t(`Narrow ${editor.grant.agentName}`, `缩减 ${editor.grant.agentName} 的访问权限`)
      : t(`Pair ${editor.agent.name}`, `配对 ${editor.agent.name}`);
    editing = (
      <form className="agents-panel__form" onSubmit={event => {
        event.preventDefault();
        void perform(async () => {
          if (editor.kind === "pairing") {
            const result = await submitJson<{ code: string; expiresAt: string }>(agentsUrl + "/" + editor.agent.id + "/pairing-codes", "POST", {
              scopes: permissions.scopes, allowedApps: permissions.allowedApps,
            });
            if (!ending.current) setSecret({ kind: "pairing", agent: editor.agent, ...result });
          } else {
            const payload = grantData(permissions);
            if (editor.permissions.expiry === expiryInputValue(editor.grant.expiresAt)) delete payload.expiresAt;
            await submitJson(agentsUrl + "/grants/" + editor.grant.id, "PATCH", payload);
            setStatus(t("Grant updated.", "授权已更新。"));
            await agents.reload();
          }
          setEditor(null);
        });
      }}>
        <h3>{heading}</h3>
        <PermissionFields draft={permissions} change={next => setEditor({ ...editor, permissions: next })}
          apps={editor.kind === "grant" ? editor.grant.allowedApps : installed} appLabel={appLabel} disabled={busy}
          scopeOptions={editor.kind === "grant" ? editor.grant.scopes : allScopes} expiry={editingGrant}
          maximumExpiry={editor.kind === "grant" ? expiryInputValue(editor.grant.expiresAt) : undefined} />
        <div className="agents-panel__actions">
          <PixelButton type="submit" size="sm" disabled={busy || permissions.scopes.length === 0}>
            {editingGrant ? t("Save grant", "保存授权") : t("Generate pairing code", "生成配对码")}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => setEditor(null)}>{t("Cancel", "取消")}</PixelButton>
        </div>
      </form>
    );
  }

  return (
    <div className="agents-panel">
      <PixelWindow title={t("Agents", "Agents")} icon="settings" className="agents-panel__window">
        {status && <StatusMessage tone="success">{status}</StatusMessage>}
        {error !== null && <StatusMessage tone="error">{errorText(error, t)}</StatusMessage>}
        {secret && (
          <section className="agents-panel__entry agents-panel__secret" aria-label={showToken ? t("One-time token", "一次性展示的令牌") : t("Pairing code", "配对码")}>
            <h3>{showToken ? t("One-time token", "一次性展示的令牌") : t("Pairing code", "配对码")}</h3>
            <p>{showToken
              ? t("Copy this token now. Settings will not show it again after you leave.", "请立即复制此令牌。离开设置后不会再次显示。")
              : t(`This code expires at ${formatTime(secret.expiresAt)}. Send it to the user who will review and approve access.`,
                `此配对码将于 ${formatTime(secret.expiresAt)} 到期。请交给需要核验并批准访问的用户。`)}</p>
            <pre>{showToken ? secret.token : secret.code}</pre>
            <div className="agents-panel__actions">
              <PixelButton size="sm" variant="secondary" onClick={() => void copy(showToken ? secret.token : secret.code)}>
                {showToken ? t("Copy token", "复制令牌") : t("Copy pairing code", "复制配对码")}
              </PixelButton>
              <PixelButton size="sm" variant="secondary" onClick={() => setSecret(null)}>{t("Dismiss", "关闭")}</PixelButton>
            </div>
            {showToken && <>
              <h4>{t("MCP Inspector 2.16.0 (legacy protocol)", "MCP Inspector 2.16.0（旧版协议）")}</h4>
              <pre>{inspectorCommand(user.username, secret.token)}</pre>
              <PixelButton size="sm" variant="secondary" onClick={() => void copy(inspectorCommand(user.username, secret.token))}>
                {t("Copy Inspector command", "复制 Inspector 命令")}
              </PixelButton>
            </>}
          </section>
        )}
        {!personalOpen && <div><PixelButton disabled={busy} onClick={() => setPersonalOpen(true)}>{t("Create personal Agent", "创建个人 Agent")}</PixelButton></div>}
        {personalOpen && (
          <form className="agents-panel__form" onSubmit={event => {
            event.preventDefault();
            if (!name.trim()) return;
            confirm(t("Authorize personal Agent", "授权个人 Agent"),
              t(`Create ${name.trim()} with ${permissionSummary(personal)}?`, `以 ${permissionSummary(personal)} 创建 ${name.trim()}？`), async () => {
                const result = await submitJson<{ agent: AgentView; token: string }>(agentsUrl, "POST", {
                  name: name.trim(), description: description.trim(), ...grantData(personal),
                });
                if (!ending.current) setSecret({ kind: "token", ...result });
                setPersonalOpen(false);
                setName("");
                setDescription("");
                setPersonal(emptyPermissions());
                await agents.reload();
              });
          }}>
            <label className="agents-panel__field">{t("Agent name", "Agent 名称")}
              <PixelInput value={name} required maxLength={64} disabled={busy} onChange={event => setName(event.target.value)} />
            </label>
            <label className="agents-panel__field">{t("Description", "说明")}
                <textarea className="px-input" value={description} maxLength={5000} disabled={busy} onChange={event => setDescription(event.target.value)} />
            </label>
            <PermissionFields draft={personal} change={setPersonal} apps={installed} appLabel={appLabel} disabled={busy} expiry />
            <div className="agents-panel__actions">
              <PixelButton type="submit" size="sm" disabled={busy || !name.trim() || personal.scopes.length === 0}>
                {t("Review authorization", "核验授权")}
              </PixelButton>
              <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => setPersonalOpen(false)}>{t("Cancel", "取消")}</PixelButton>
            </div>
          </form>
        )}
        {agents.loading && <LoadingState label={t("Loading Agents…", "正在加载 Agents…")} />}
        {agents.error && <StatusMessage tone="error">
          {t("Could not load Agents.", "无法加载 Agents。")}{" "}
          <PixelButton size="sm" variant="secondary" onClick={() => void agents.reload()}>{t("Retry", "重试")}</PixelButton>
        </StatusMessage>}
        {agents.data?.owned.length === 0 && <EmptyState title={t("No Agents owned by you", "您没有创建过 Agent")} />}
        {(agents.data?.owned ?? []).map(agent => (
          <section key={agent.id} className="agents-panel__entry">
            <h3>{agent.name}</h3>
            {agent.description && <p>{agent.description}</p>}
            <div className="agents-panel__actions">
              <StatusChip chip={{ id: agent.status, label: agent.status === "active" ? t("Active", "有效") : t("Revoked", "已撤销"),
                tone: agent.status === "active" ? "success" : "neutral" }} />
              <code>{agent.tokenPrefix}…</code>
              {agent.requiresExplicitActor && <small>{t("Acting user required", "需指定代操作用户")}</small>}
              {agent.lastUsedAt && <small>{t("Last used", "上次使用")} <time dateTime={agent.lastUsedAt}>{formatTime(agent.lastUsedAt)}</time></small>}
            </div>
            {agent.status === "active" && <div className="agents-panel__actions">
              <PixelButton size="sm" variant="secondary" disabled={busy}
                onClick={() => setEditor({ kind: "pairing", agent, permissions: emptyPermissions() })}>
                {t("Create pairing code", "创建配对码")}
              </PixelButton>
              <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => rotate(agent)}>{t("Rotate token", "轮换令牌")}</PixelButton>
              <PixelButton size="sm" variant="danger" disabled={busy} onClick={() => revokeAgent(agent)}>{t("Revoke Agent", "撤销 Agent")}</PixelButton>
            </div>}
            {editor?.kind === "pairing" && editor.agent.id === agent.id && editing}
          </section>
        ))}
      </PixelWindow>
      <PixelWindow title={t("Pair with an Agent", "配对 Agent")} className="agents-panel__window">
        <form className="agents-panel__form" onSubmit={event => {
          event.preventDefault();
          const code = inputCode.trim();
          if (!code) return;
          void perform(async () => {
            const preview = await submitJson<PairingPreview>(agentsUrl + "/pairings/preview", "POST", { code });
            if (!ending.current) setApproval({ preview, code, permissions: { ...preview, expiry: "" } });
          });
        }}>
          <label className="agents-panel__field">{t("Pairing code", "配对码")}
            <PixelInput autoComplete="off" spellCheck={false} value={inputCode} required maxLength={256}
              disabled={busy} onChange={event => { setInputCode(event.target.value); setApproval(null); }} />
          </label>
          <div><PixelButton type="submit" size="sm" disabled={busy || !inputCode.trim()}>{t("Preview pairing", "预览配对")}</PixelButton></div>
        </form>
        {approval && (
          <form className="agents-panel__form" onSubmit={event => {
            event.preventDefault();
            confirm(t("Approve pairing", "批准配对"),
              t(`Allow ${approval.preview.agentName} to use ${permissionSummary(approval.permissions)} on your account?`,
                `允许 ${approval.preview.agentName} 以 ${permissionSummary(approval.permissions)} 访问您的账号？`), async () => {
                await submitJson(agentsUrl + "/pairings/approve", "POST", { code: approval.code, ...grantData(approval.permissions) });
                setApproval(null);
                setInputCode("");
                setStatus(t("Pairing approved.", "配对已批准。"));
                await agents.reload();
              });
          }}>
            <h3>{approval.preview.agentName}</h3>
            <p>{t(`Owned by ${approval.preview.ownerName}. The owner controls the credential. Rotating it retains the access you approve.`,
              `所有者是 ${approval.preview.ownerName}。所有者控制凭据，轮换凭据后仍保留您批准的访问权限。`)}</p>
            <p>{t("Approve before", "审批截止时间")} <time dateTime={approval.preview.expiresAt}>{formatTime(approval.preview.expiresAt)}</time></p>
            <PermissionFields draft={approval.permissions} change={permissions => setApproval({ ...approval, permissions })}
              apps={approval.preview.allowedApps} scopeOptions={approval.preview.scopes} appLabel={appLabel} disabled={busy} expiry />
            <div><PixelButton type="submit" size="sm" disabled={busy || approval.permissions.scopes.length === 0}>
              {t("Review pairing approval", "核验配对审批")}
            </PixelButton></div>
          </form>
        )}
      </PixelWindow>
      <PixelWindow title={t("Your grants", "您的授权")} className="agents-panel__window">
        {agents.data?.grants.length === 0 && <EmptyState title={t("No grants for this account", "此账号没有授权")} />}
        {(agents.data?.grants ?? []).map(grant => {
          const state = grantStatus(grant);
          return <section key={grant.id} className="agents-panel__entry">
            <h3>{grant.agentName}</h3>
            <div className="agents-panel__actions">
              <StatusChip chip={{ id: state, label: state === "active" ? t("Active", "有效")
                : state === "expired" ? t("Expired", "已过期") : t("Revoked", "已撤销"), tone: state === "active" ? "success" : "neutral" }} />
              <span>{t("Owner", "所有者")} {grant.ownerName}</span>
            </div>
            <p>{permissionSummary(grant)}</p>
            <p>{grant.expiresAt ? <>{t("Expires", "到期时间")} <time dateTime={grant.expiresAt}>{formatTime(grant.expiresAt)}</time></> : t("No expiration", "无到期时间")}</p>
            {state === "active" && <div className="agents-panel__actions">
              <PixelButton size="sm" variant="secondary" disabled={busy} onClick={() => openGrantEditor(grant)}>{t("Narrow access", "缩减访问权限")}</PixelButton>
              <PixelButton size="sm" variant="danger" disabled={busy} onClick={() => revokeGrant(grant)}>{t("Revoke grant", "撤销授权")}</PixelButton>
            </div>}
            {editor?.kind === "grant" && editor.grant.id === grant.id && editing}
          </section>;
        })}
        <p>{t("To approve broader access or extend a paired grant, revoke this grant and approve a fresh pairing code from its owner.",
          "如需增加访问权限或延长配对授权，请撤销当前授权，再批准所有者提供的新配对码。")}</p>
        <details>
          <summary>{t("MCP Inspector 2.16.0 (legacy protocol)", "MCP Inspector 2.16.0（旧版协议）")}</summary>
          <p>{t(`Use the owner's token. The acting-user header is set to ${user.username}; paired Agents require this header.`,
            `请使用所有者提供的令牌。代操作用户请求头已设为 ${user.username}，配对后的 Agent 必须使用此请求头。`)}</p>
          <pre>{inspectorCommand(user.username)}</pre>
          <PixelButton size="sm" variant="secondary" onClick={() => void copy(inspectorCommand(user.username))}>{t("Copy Inspector template", "复制 Inspector 模板")}</PixelButton>
        </details>
      </PixelWindow>
      <PixelWindow title={t("Agent activity", "Agent 活动")} className="agents-panel__window">
        <div><PixelButton size="sm" variant="secondary" disabled={audit.loading} onClick={() => {
          if (cursors.length) setCursors([]);
          else void audit.reload();
        }}>{t("Refresh activity", "刷新活动")}</PixelButton></div>
        {audit.loading && <LoadingState label={t("Loading activity…", "正在加载活动…")} />}
        {audit.error && <StatusMessage tone="error">{t("Could not load Agent activity.", "无法加载 Agent 活动。")}</StatusMessage>}
        {audit.data?.items.length === 0 && <EmptyState title={t("No Agent activity", "没有 Agent 活动")} />}
        {(audit.data?.items ?? []).length > 0 && <ul className="agents-panel__audit">
          {audit.data!.items.map(item => <li key={item.id} className="agents-panel__entry">
            <div className="agents-panel__actions">
              <StatusChip chip={{ id: item.id, label: t(`Agent: ${item.agentName}`, `Agent：${item.agentName}`), tone: "info" }} />
              <span>{appLabel(item.appId)}</span>
              <code>{item.toolName}</code>
              <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
            </div>
            <p>{auditStatus(item.status, t)}{item.errorCode && <> · <code>{item.errorCode}</code></>}</p>
            {item.resourceId && <small>{t("Record", "记录")} <code>{item.resourceId}</code></small>}
          </li>)}
        </ul>}
        {(cursors.length > 0 || audit.data?.nextCursor) && <nav className="agents-panel__actions" aria-label={t("Activity pages", "活动分页")}>
          <PixelButton size="sm" variant="secondary" disabled={audit.loading || cursors.length === 0}
            onClick={() => setCursors(prior => prior.slice(0, -1))}>{t("Previous", "上一页")}</PixelButton>
          <PixelButton size="sm" variant="secondary" disabled={audit.loading || !audit.data?.nextCursor} onClick={() => {
            const next = audit.data?.nextCursor;
            if (next) setCursors(prior => [...prior, next]);
          }}>{t("Next", "下一页")}</PixelButton>
        </nav>}
      </PixelWindow>
      {confirmation && <ConfirmDialog title={confirmation.title} message={confirmation.message} confirmLabel={t("Confirm", "确认")}
        busy={busy} onConfirm={() => void perform(confirmation.action)} onCancel={() => setConfirmation(null)} />}
    </div>
  );
}

function auditStatus(status: AuditItem["status"], t: Translate): string {
  switch (status) {
    case "ok": return t("Succeeded", "已成功");
    case "replayed": return t("Create receipt replayed", "已重放创建回执");
    case "conflict": return t("Conflict", "冲突");
    case "denied": return t("Denied", "已拒绝");
    case "error": return t("Failed", "失败");
  }
}
