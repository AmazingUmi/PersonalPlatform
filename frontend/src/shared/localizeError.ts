import type { Language } from "./i18n";

/** Translate only application-owned messages/codes; never translate arbitrary user content. */
export function localizeError(error: unknown, language: Language): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (language === "en") return message;
  const messages: Record<string, string> = {
    "task not found": "任务不存在。", "item not found": "资产不存在。", "category not found": "分类不存在。", "attachment not found": "附件不存在。",
    "Invalid focus server time": "专注服务返回的时间无效。",
    "Failed to fetch": "网络连接失败，请检查后端服务。",
    "NetworkError when attempting to fetch resource.": "网络连接失败，请检查后端服务。",
    "Access denied — unknown user or wrong password.": "登录失败：用户名或密码不正确。",
    "Too many attempts — wait a moment and try again.": "尝试次数过多，请稍后重试。",
    "Login failed.": "登录失败。", "Could not create the user.": "无法创建用户。",
    "The operation failed. Please try again.": "操作失败，请重试。",
    "The backup exceeds the 32 MiB limit.": "备份超过了 32 MiB 的大小限制。",
    "Select a valid Settings JSON backup. SQL and archive backups need offline conversion first.": "请选择有效的 JSON 备份。SQL 或归档备份需要先离线转换。",
    "Could not read the backup download.": "无法读取下载的备份。",
    "WebDAV host could not be resolved.": "无法解析 WebDAV 主机，请检查后端的 DNS 设置。",
    "WebDAV request failed or timed out. Check the address, TLS certificate and connection.": "WebDAV 请求失败或超时，请检查地址、TLS 证书和网络连接。",
    "WebDAV download was interrupted.": "WebDAV 下载已中断。",
    "A record belongs to another user.": "某条记录属于其他用户，无法合并。",
  };
  if (messages[message]) return messages[message]!;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const codes: Record<string, string> = {
    invalid_time_interval: "截止时间不能早于开始时间。", category_not_found: "分类不存在。", attachment_too_large: "附件超过大小限制。",
    unauthorized: "请重新登录。", forbidden: "当前账号没有执行此操作的权限。",
    validation_error: "输入内容不符合要求，请检查各字段。", invalid_credentials: "用户名或密码不正确。",
    username_taken: "该用户名已被使用。", category_name_taken: "该分类名称已存在。",
    note_not_found: "笔记不存在或已被删除。", task_not_found: "任务不存在或已被删除。",
    asset_not_found: "资产不存在或已被删除。", backup_busy: "备份正在运行或尚未配置，请稍后重试。",
    password_required: "新的 WebDAV 地址或用户名需要重新输入密码。",
    invalid_password: "请输入有效的非空密码。", invalid_webdav_username: "WebDAV 用户名不能包含冒号或换行。",
    invalid_webdav_url: "请输入有效的 WebDAV 目录地址。", backup_too_large: "备份或响应超过大小限制。",
    webdav_not_configured: "请填写 WebDAV 连接信息后测试。", invalid_webdav_test: "测试连接需要地址、用户名以及可选的密码。",
    backup_not_found: "当前连接下无法找到该备份。", backup_integrity_error: "备份完整性校验失败。",
  };
  if (codes[code]) return codes[code]!;
  const diagnostic: Record<string, string> = { webdav_origin_blocked: "WebDAV 地址在认证前被网络策略拦截。请检查 DNS / Fake-IP，或由管理员配置可信的精确 origin。", webdav_failed: "WebDAV 服务返回错误，请根据下方 HTTP 状态检查账号、应用密码或目录权限。", webdav_unreachable: "无法连接 WebDAV 服务。", backup_timeout: "备份连接超时。" };
  return diagnostic[code] ? `${diagnostic[code]}\n${message}` : message;
}
