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
npm run backup            # 写入 backups/personal_platform_<时间戳>.sql

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

## 禁用 / 启用 App 与迁移的关系

- 禁用：数据与 schema 原样保留；禁用期间发布的新迁移会在下一次启动时照常应用（禁用 App 也在迁移目标集内）。
- 运行时启用：Core 在激活前先补齐该 App 的未应用迁移，成功后再注册其 API/事件/Job；迁移失败则置为 `status=error`（保留 `enabled=true`），不激活。无需重启后端。
- 永不因禁用而 DROP 任何业务 schema。
