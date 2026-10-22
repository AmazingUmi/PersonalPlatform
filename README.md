# Personal Platform

面向个人使用的模块化 Web 平台。架构依据 [`doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md`](doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md)，实现进度见 [`doc/IMPLEMENTATION_PLAN.md`](doc/IMPLEMENTATION_PLAN.md)。

## 已交付（v0.1）

- **Core**：App Registry、Manifest 校验（YAML + JSON Schema）、配置加载、统一日志与错误格式、健康检查
- **数据**：PostgreSQL Schema 隔离（`core.*` / `assets.*` / `focus.*` / `tasks.*` / `mini_game.*`），Core 与 App 独立 Migration（`node-pg-migrate`）；App Migration 跟随"已安装"而非"已启用"——禁用的 App 依然保持 schema 升级、数据保留，运行时 Enable 会先补齐 pending migration 再激活，无需重启
- **生命周期**：`enabled` 记录用户期望、`status` 记录真实运行状态；激活失败呈现为 `enabled=true / status=error`（App Center 提供 Retry / Disable），Disable/Enable 后 API、导航、Widget、事件、任务即时生效，数据保留
- **前端 Shell**：React Router 导航、Dashboard（Widget 网格 + Error Boundary + 点击导航 + 拖拽排序/隐藏/恢复）、App Center（启停 + 昵称/Accent 个性化）、Settings
- **共享服务**：Storage（本地驱动 + 路径安全）、Event Bus（进程内 typed pub/sub）、Scheduler（cron / interval / one-shot）
- **四个验证 App**：Assets（Item/Category CRUD + 附件上传下载删除 + 服务端搜索/过滤/排序）、Tasks（start/deadline/priority + 编辑器 + 筛选排序）、Mini Game（2048 方向键/WASD + 历史高分 + 防陈旧存档）、Focus（番茄钟 + 后端权威计时/恢复 + 历史/统计 + Dashboard 快捷控制）
- **查询状态**：Assets / Tasks 的搜索、过滤、排序进入 URL search params（刷新/前进后退/收藏/深链），搜索带 250ms debounce；排序字段走显式 allowlist，禁止任意 SQL 插值
- **工程化**：单元/集成/前端测试、E2E（Playwright）、备份脚本、App 模板与生成脚本、`scripts/verify.sh` 验收脚本、GitHub Actions（含 PostgreSQL service）

## 开发启动

前置条件：Node.js 22+；本地或 Docker 的 PostgreSQL 17。

```bash
cp .env.example .env       # 可选；默认值可直接运行
make dev                   # 等价于 docker compose up --build
```

启动后：

- Web Shell: <http://localhost:5173>（默认仅绑定 `127.0.0.1`）

默认网络拓扑（见下方"网络安全默认值"）：database 与 backend 只在 Docker 网络内可达，不对宿主机发布端口；因此 Backend 的 8000 与 PostgreSQL 的 5432 默认无法从宿主机直接访问。

停止：`make down`。

### 生产部署

开发与生产使用独立 Compose 文件。生产运行编译后的 Node 后端和 Nginx 静态前端，不挂载开发源码。

```bash
cp .env.production.example .env.production
# 填写数据库和管理员密码；正式使用配置 HTTPS 反向代理。
make prod
make prod-ps
```

生产默认项目与开发数据分离，数据库和附件使用命名卷；`make prod-down` 停止服务并保留数据。现有部署须先备份、停写并迁移数据，不能直接把全新生产卷当成旧数据。完整操作、HTTP 验证和迁移步骤见 [Docker 部署指南](doc/DEPLOYMENT.md)。

镜像构建和真实启动验收：`npm run verify:docker`（需要 Docker daemon，自动使用并清理独立临时项目）。

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

## 身份认证（多用户）

平台内置会话认证与按用户隔离的数据所有权（Core 能力，`backend/src/core/auth/`）：

- **首个管理员**：数据库迁移只播种一个占位管理员（用户名 `admin`，`!bootstrap-pending` 占位密码哈希，激活前无法登录）。两种激活方式：
  - 启动时设置环境变量 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`（见 `.env.example`，后端启动时自动激活）；
  - 或 CLI：`npm run bootstrap:admin -- --username <name>`（隐藏密码输入，也接受 `BOOTSTRAP_ADMIN_PASSWORD` 环境变量）。

  激活是幂等的：**绝不重置已激活的密码**；当请求的用户名与占位管理员不同且其仍处于未激活状态时，会原地改名（id 稳定，已回填的数据继续归属该账号）。真实密码不进 git。bootstrap 只负责建立**第一个**管理员：一旦已存在激活的管理员且没有待激活占位符，即使之后误改环境变量里的用户名/密码，启动时也只会记一条警告日志并跳过（不会创建第二个管理员，也不会重置现有密码）。
- **登录**：前端提供 `/login` 登录页；`POST /api/core/auth/login` 成功后签发 HttpOnly Cookie `pp_session`（SameSite=Lax、Path=/、生产环境启用 Secure）。会话为服务端会话，存于 `core.sessions`：数据库只保存 sha256(token)，令牌本身为 256-bit 随机 base64url；有效期 30 天，另有每小时的过期会话清理 Job。登录接口按「用户名 + 客户端 IP」限速：每 5 分钟 10 次失败。登出（`POST /api/core/auth/logout`，幂等：无论会话是否有效都清除 Cookie 并返回 204）与会话自省（`GET /api/core/auth/me`）配套提供；用户管理 API（`GET/POST /api/core/auth/users`）仅管理员可用。

  认证后端故障（如数据库瞬断）返回 **503** 而非 401——前端据此显示"后端不可用"而非"未登录"（401 才跳转登录页）。
- **生产部署相关环境变量**（Docker Compose 已透传，见 `.env.example`）：
  - `PLATFORM_ENVIRONMENT=production`：运行环境声明，**环境变量优先于** `config/platform.yaml`。生产环境下 `pp_session` Cookie 自动带 `Secure`（须部署在 HTTPS 之后）；
  - `SESSION_COOKIE_SECURE=true|false`：显式覆盖 Secure 标志，优先级最高（仅在明确的 HTTP-only 生产部署时才需要 `false`）。绝不根据请求头猜测，也不会因反代配置错误而自动降级；
  - `TRUST_PROXY=loopback|uniquelocal|<IP/CIDR 列表>`：声明可信反向代理后，登录限速才会采用 `X-Forwarded-For` 解析出的客户端 IP。默认不信任任何代理（伪造 `X-Forwarded-For` 无法绕过限速）；`true` 表示完全信任，仅在后端只能经由代理访问时使用。预期拓扑：`Browser → (Nginx/TLS) → frontend/backend`，Compose 网络可用 `uniquelocal`（172.16.0.0/12）。
- **多用户数据隔离**：所有 App 的业务数据行都以 `user_id` 归属（NOT NULL 外键 → `core.users`，级联删除）；查询始终按当前用户过滤，访问他人资源返回 404。用户文件（如附件）根目录为 `storage/users/<userId>/apps/<appId>/`。
- **创建更多用户**：管理员登录后在 Settings → Users 面板创建普通账号；管理员账号只能通过 bootstrap 产生。

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

**恢复会覆盖当前数据**：先停止后端和调度并保存操作前的完整备份。restore 先检查并暂存附件、配置及原文件副本，再在同一数据库事务内删除并重建备份中的 schema；SQL 执行错误会整体回滚，文件尚未安装。数据库提交后才替换 `storage/` 与 `config/`，两种存储没有共同事务；若文件安装失败，命令非零退出并报告保留旧、新文件树的 `.restore-stage-*` 路径。保持停机并按[恢复失败处理](doc/MIGRATION_RUNBOOK.md#恢复失败处理)完成恢复，不能把部分完成当成整体回滚。

恢复必须显式 `--yes`，仅接受本工具可信的备份及平台规范的 schema 标识符；格式版本不匹配、归档损坏或预复制失败会在数据库变更前拒绝。往返、SQL 回滚、归档预检及文件安装失败由 `backend/test/integration/backup-restore.test.ts` 覆盖，需要 PostgreSQL 17 的 `pg_dump`/`psql`。

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
