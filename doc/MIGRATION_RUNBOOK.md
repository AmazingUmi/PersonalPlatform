# Migration Runbook

数据库迁移策略与操作手册（v0.1：只支持前向迁移，不承诺自动 downgrade）。

## 原则

1. Core 与每个 App 各自维护迁移目录与记录表：
   - Core：`migrations/core/`，记录表 `core.migrations`
   - App：`apps/<id>/migrations/`，记录表 `<id>.migrations`
2. 执行顺序：Core → **已安装**（valid manifest）App（按 app id 稳定排序），禁用 App 同样迁移：migration 跟随安装状态而非启用状态，禁用 App 数据保留、schema 照常升级、不回滚、不删表。
3. 迁移期间 node-pg-migrate 持有 PostgreSQL advisory lock，防并发执行；任一 scope 失败即中止启动并报告具体 App。
4. 迁移文件为前向 SQL：`<YYYYMMDDHHMMSS>-<name>.sql`，按文件名时间戳排序执行，每个 scope 的整批迁移在单事务中应用。

## 日常操作

```bash
# 创建新迁移
npm run migration:create -- --scope core --name add_settings_meta
npm run migration:create -- --scope assets --name add_items_tags

# 应用（等价于后端启动时自动执行）
npm run migration:up

# 查看各 scope 状态
npm run migration:status
```

后端每次启动都会自动执行迁移（Core 先行，随后在 App 激活前执行已启用 App 的迁移）。`migration:up` 与启动逻辑共用同一实现。

## 发布流程（含备份）

```bash
# 1. 发布前必须备份（生产发布约定）
npm run backup            # 写入 backups/personal_platform_<时间戳>/

# 2. 应用迁移
npm run migration:up

# 3. 验证
npm run migration:status
curl -fsS http://localhost:8000/api/core/health/ready

# 4. 冒烟验收
npm run verify
```

## 失败处理

- 单个 scope 失败：启动中止，日志包含 `migration failed for scope '<id>'`。修复 SQL 后重启即可（单事务保证无半迁移状态）。
- 迁移卡住（advisory lock 被占）：查 `SELECT pid, query FROM pg_stat_activity WHERE wait_event_type = 'Lock';`，确认后终止持锁会话。
- 需要回退数据结构时：编写新的前向迁移纠正，不编辑已应用的历史文件。

## 恢复失败处理

恢复前停止后端、调度和其他写入者，并保存操作前完整的数据库、storage 和 config 备份。本工具导入的是可信 pg_dump plain SQL/tar，支持平台规范的 schema 名（字母/下划线开头，其后字母、数字、下划线）；不用于导入任意不可信 SQL 或归档。

| 失败阶段 | 数据状态与动作 |
|---|---|
| 格式、解包或预复制失败 | 数据库尚未变更，原文件未安装修改；修复备份/权限/空间后重试 |
| SQL 执行错误 | 所有 DROP 与 SQL 导入由同一个 psql 单事务回滚；原 storage/config 保留 |
| 数据库连接中断 | 文件安装尚未开始；尤其在 COMMIT 附近中断时需核对数据库结果，不能仅凭客户端报错判断是否提交 |
| 数据库已提交、文件安装失败 | 明确报告部分完成；`.restore-stage-*` 保留 `previous-storage`、`previous-config`、`incoming/storage`、`incoming/config` 及导入 SQL（原目录不存在时没有对应 previous 副本） |

最后一种情况保持服务停止，先保全日志报告的 staging 路径。修复存储故障后，可依据已提交的数据库和 `incoming/` 完成文件安装；如需整体回退，使用操作前的完整备份，不能仅回退旧文件后恢复服务。确认数据库、附件和配置一致才启动。成功及普通失败会清理 staging；部分完成的 staging 不会自动删除，应在确认恢复后由操作者处理。

预暂存会同时保存待安装文件与原文件，需预留相应磁盘空间。目录内容复制兼容 storage 根为卷挂载点；已有 storage/config 根若为符号链接或普通文件会在数据库变更前拒绝，避免产生仍指向活目录的伪快照。数据库和文件系统不提供共同的原子提交或崩溃自动恢复。

## 禁用 / 启用 App 与迁移的关系

- 禁用：数据与 schema 原样保留；禁用期间发布的新迁移会在下一次启动时照常应用（禁用 App 也在迁移目标集内）。
- 运行时启用：Core 在激活前先补齐该 App 的未应用迁移，成功后再注册其 API/事件/Job；迁移失败则置为 `status=error`（保留 `enabled=true`），不激活。无需重启后端。
- 永不因禁用而 DROP 任何业务 schema。

## 单用户 → 多用户升级（AUTH，一次性）

从单用户版本升级到带认证的多用户版本时，后端启动按以下顺序自动完成，**任一步失败即拒绝启动（fatal）**，不存在半升级的可用状态：

1. **Core 用户/会话迁移**：`migrations/core/20260916000001-users-sessions.sql` 建 `core.users` / `core.sessions`，并播种**恰好一个占位管理员**（用户名 `admin`，密码哈希 `!bootstrap-pending`——激活前无法登录，git 中不含任何可用密码）。
2. **Bootstrap 激活**：设置了 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 时，后端启动即激活占位管理员；也可用 CLI `npm run bootstrap:admin -- --username <name>`（隐藏密码输入）。幂等，**绝不重置已激活的密码**；请求的用户名不同且占位符仍待激活时会原地改名（id 稳定，后续回填的数据继续归属该账号）。
3. **遗留文件搬迁**：`backend/src/core/storage/legacy-move.ts` 在激活前把 `storage/apps/<appId>/**` 移动到 `storage/users/<owner>/apps/<appId>/**`（搬迁在 App 激活、特别是 assets 启动对账之前完成，避免对账把旧路径文件当成"丢失"而清掉元数据）。一次性执行，完成标记为 `core.settings` 中的 marker 行 `platform.storage.userscope.v1`；中途崩溃无标记，下次重跑收敛（逐文件 rename 覆盖目标）。任何失败都会让启动失败。
4. **App 归属迁移回填**：各 App 的 `apps/*/migrations/20260916100000-user-ownership.sql` 为每张业务表加 `user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`，并把存量行回填到 bootstrap 用户；若任一行会保持 NULL，迁移中的 DO 块直接 RAISE EXCEPTION（fail loudly），不会出现无主数据。

### 备份/恢复注意（升级后）

App schema 现在携带指向 `core.users` 的外键。恢复备份时**必须保持 core schema 与 App schema 一致**——只恢复部分 App schema 而不同时恢复 `core`（或反之，先恢复了不含相应用户行的旧 `core` 快照）会因 FK 指向不存在的用户而失败或产生悬挂引用。生产约定不变：恢复用完整的 `npm run restore -- backups/<timestamp> --yes`（数据库逻辑备份 + storage 整体 + config），不要手工拼装混合快照。
