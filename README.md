# Personal Platform

面向个人使用的模块化 Web 平台。架构依据 [`doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md`](doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md)，实现进度见 [`doc/IMPLEMENTATION_PLAN.md`](doc/IMPLEMENTATION_PLAN.md)。

## 已交付（v0.1）

- **Core**：App Registry、Manifest 校验（YAML + JSON Schema）、配置加载、统一日志与错误格式、健康检查
- **数据**：PostgreSQL Schema 隔离（`core.*` / `assets.*` / `tasks.*` / `mini_game.*`），Core 与 App 独立 Migration（`node-pg-migrate`）；App Migration 跟随"已安装"而非"已启用"——禁用的 App 依然保持 schema 升级、数据保留，运行时 Enable 会先补齐 pending migration 再激活，无需重启
- **生命周期**：`enabled` 记录用户期望、`status` 记录真实运行状态；激活失败呈现为 `enabled=true / status=error`（App Center 提供 Retry / Disable），Disable/Enable 后 API、导航、Widget、事件、任务即时生效，数据保留
- **前端 Shell**：React Router 导航、Dashboard（Widget 网格 + Error Boundary + 点击导航 + 拖拽排序/隐藏/恢复）、App Center（启停 + 昵称/Accent 个性化）、Settings
- **共享服务**：Storage（本地驱动 + 路径安全）、Event Bus（进程内 typed pub/sub）、Scheduler（cron / interval / one-shot）
- **三个验证 App**：Assets（Item/Category CRUD + 附件上传下载删除 + 服务端搜索/过滤/排序）、Tasks（start/deadline/priority + 编辑器 + 筛选排序）、Mini Game（2048 方向键/WASD + 历史高分 + 防陈旧存档）
- **查询状态**：Assets / Tasks 的搜索、过滤、排序进入 URL search params（刷新/前进后退/收藏/深链），搜索带 250ms debounce；排序字段走显式 allowlist，禁止任意 SQL 插值
- **工程化**：单元/集成/前端测试、E2E（Playwright）、备份脚本、App 模板与生成脚本、`scripts/verify.sh` 验收脚本、GitHub Actions（含 PostgreSQL service）

## 启动

前置条件：Node.js 22+；本地或 Docker 的 PostgreSQL 17。

```bash
cp .env.example .env       # 可选；默认值可直接运行
make dev                   # 等价于 docker compose up --build
```

启动后：

- Web Shell: <http://localhost:5173>（默认仅绑定 `127.0.0.1`）

默认网络拓扑（见下方"网络安全默认值"）：database 与 backend 只在 Docker 网络内可达，不对宿主机发布端口；因此 Backend 的 8000 与 PostgreSQL 的 5432 默认无法从宿主机直接访问。

停止：`make down`。

### 网络安全默认值

默认 `docker compose up`：

- frontend → 宿主机 `127.0.0.1:5173`（仅本机可访问）
- backend → 仅 Docker 网络内可达（frontend 代理 `/api`）
- database → 仅 Docker 网络内可达

需要调试或 LAN 使用时：

```bash
make dev-expose   # database/backend 发布到宿主机回环，frontend 开放到所有网卡
# 或按需覆盖：BIND_IP=0.0.0.0 docker compose up
```

详见 `docker/compose.expose.yml`。

## 本地开发与验收

不使用容器时：

```bash
npm ci
npm run generate:apps     # 生成编译期模块表
npm run check             # 前后端类型检查
npm run build             # 前后端构建
npm test                  # 单元测试（后端 + 前端）
npm run test:integration  # 集成测试（需 TEST_DATABASE_URL 可达）
npm run e2e               # Playwright E2E（需本地 Chrome；自动拉起前后端与 E2E 库）
bash scripts/verify.sh    # 一键验收（含 DB 可达性探测与后端冒烟测试）
```

数据库迁移：

```bash
npm run migration:status
npm run migration:up
npm run migration:create -- --scope assets --name add_items
```

新增 App：

```bash
npm run create:app -- assets "Asset Manager"
```

### 备份与恢复（FP-11）

```bash
npm run backup                                    # 备份到 backups/<timestamp>/
npm run restore -- backups/<timestamp> --yes      # 恢复（必须显式 --yes）
```

备份目录包含：`database.sql`（pg_dump 逻辑备份）、`storage.tar.gz`（全部本地存储）、`config/`（非敏感配置）、`metadata.json`（格式版本、创建时间、平台版本、App 列表）。`.env` 密钥、`node_modules`、构建产物永不打包。

**恢复会覆盖当前数据**：restore 会删除并重建数据库中备份所含的 schema（在单事务中执行，失败自动回滚）、整体替换 `storage/` 并覆盖 `config/`。因此 restore 不带 `--yes` 时直接拒绝执行。格式版本不匹配（`formatVersion`）的备份会被拒绝。端到端往返（备份→破坏→恢复→校验数据库与附件）由 `backend/test/integration/backup-restore.test.ts` 自动化覆盖，需要 `pg_dump`/`psql`（本地可用 Homebrew PostgreSQL 自带；CI 安装 postgresql-client-17）。

## 目录

```text
backend/             Fastify 后端进程（core/ + apps/<id>/）
frontend/            React Web Shell（shell/ + shared/ + apps/<id>/）
apps/                App 元数据真源（app.yaml + migrations/ + README）
migrations/core/     Core Schema 迁移
config/              非敏感平台配置
storage/             本地存储挂载点
scripts/             生成器、备份、App 模板、验收脚本
docker/              开发镜像
doc/                 设计与实施文档
```

## 配置约定

- 密钥、密码和环境差异通过环境变量提供，不提交 `.env`。
- `config/platform.yaml` 保存非敏感平台配置；App 配置位于 `config/apps/<id>.yaml`。
- Compose 中的默认密码仅用于本地开发，不得用于生产。
