# 开发指南

面向在本仓库开发的贡献者。架构与范围见 [`PERSONAL_PLATFORM_INITIAL_DESIGN.md`](PERSONAL_PLATFORM_INITIAL_DESIGN.md)，阶段计划见 [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)，新 App 接入见 [`APP_DEVELOPMENT.md`](APP_DEVELOPMENT.md)。

## 环境要求

- Node.js ≥ 22（推荐 22 LTS）
- PostgreSQL 17（本地安装或 Docker Compose 提供）
- Docker（可选，仅用于 Compose 一键启动）

## 常用命令

```bash
npm ci                      # 安装依赖
npm run generate:apps       # 扫描 apps/*/app.yaml，刷新前后端编译期模块表
npm run check               # 生成表一致性检查 + 前后端类型检查
npm run build               # 生成模块表 + 构建后端 dist 与前端 dist
npm test                    # 后端单元测试 + 前端 Vitest
npm run test:integration    # 后端集成测试（需要 PostgreSQL）

npm run migration:up        # Core + 已安装 App（含禁用）的迁移
npm run migration:status    # 各 scope 已应用迁移
npm run migration:create -- --scope assets --name add_items

npm run create:app -- my_app "My App"   # 从模板创建新 App
npm run bootstrap:admin -- --username admin   # 激活/创建首个管理员（隐藏密码输入）
npm run backup              # 备份数据库（backup.sh backup|restore）
npm run verify              # 本地完整验收（见 scripts/verify.sh）
```

## 数据库

- 开发库连接串由 `DATABASE_URL` 提供（`.env` / 环境变量，不提交）。
- 集成测试默认使用 `TEST_DATABASE_URL`（默认 `...127.0.0.1:5439/personal_platform_test`），每个测试文件会清空全部业务 schema 并重放 Core 迁移。
- Schema 隔离：Core 用 `core`，每个 App 用自己的 `<app_id>` schema；App 只能写自己的 schema（有静态检查测试 `backend/test/unit/isolation.test.ts`）。
- 迁移执行顺序：Core → 已安装 App（按 id 排序，含禁用 App）；禁用 App 数据保留、schema 照常升级，只是 API/Widget/Job/Event 不运行。运行时 Enable 会先补齐该 App 的 pending migration 再激活，因此不需要重启后端。详见 [`MIGRATION_RUNBOOK.md`](MIGRATION_RUNBOOK.md)。

## 后端结构

```text
backend/src/
├── core/               # 平台核心，不含业务逻辑
│   ├── api/            # /api/core/* 路由 + 统一错误
│   ├── auth/           # 会话认证：登录/登出/me、用户管理 API（管理员）
│   ├── app-registry/   # Manifest 校验、扫描、注册表、AppContext
│   ├── config/         # platform.yaml + 环境变量
│   ├── database/       # pg.Pool 封装、事务、迁移编排
│   ├── events/         # 进程内 Event Bus
│   ├── scheduler/      # cron / interval / one-shot 调度
│   ├── storage/        # 本地文件存储驱动（按 App 隔离根目录）
│   ├── logging/ health/
│   └── platform.ts     # createPlatform：装配一切
├── apps/<id>/          # 各 App 后端模块（default export）
├── cli/migrate.ts      # 迁移 CLI
├── generated/apps.ts   # 生成文件，勿手改
└── main.ts             # 进程入口：配置→迁移→装配→监听→优雅关闭
```

App 通过 `AppContext` 获得 `api`（前缀 `/api/apps/<id>`，先后受生命周期 guard（404）与认证 guard（401）保护）、`auth`（`ctx.auth.requireUser` 取当前用户）、`database`、`storage`（App 级根目录 `storage/apps/<id>`；用户文件用 `forUser(userId)`，根目录 `storage/users/<userId>/apps/<id>`）、`events`、`scheduler`、`log`。App 之间不互相 import、不跨 schema 写数据，也不直接读 Cookie 或 `core.sessions`。

## 前端结构

```text
frontend/src/
├── shell/              # 导航、路由、Dashboard、App Center、Settings
├── shared/             # api 客户端、类型、ErrorBoundary、useAsync（无业务逻辑）
├── apps/<id>/          # 各 App 页面与 Widget（default export）
└── generated/apps.ts   # 生成文件，勿手改
```

Shell 用 `GET /api/core/apps` 的启用状态与编译期模块表求交集：禁用的 App 自动从导航、路由与 Dashboard Widget 中消失。Widget 顺序与可见性持久化在 `core.settings`（key `dashboard.widgets`），渲染顺序即保存顺序；Edit Layout 模式支持拖拽排序（仅通过标题栏 drag handle）、隐藏/恢复、恢复默认。用户对 App 的昵称/Accent 个性化持久化在 `core.settings`（key `apps.presentation`），由 `shared/presentation.ts` 统一 resolve 后应用到 App Center、Dock、Mobile Nav、Dashboard 与 App 页头；`app.yaml` 运行时只读。

## API 约定

- Core：`/api/core/*`；App：`/api/apps/<app_id>/*`。
- 错误统一 `{ error: { code, message, requestId, details? } }`；非 enabled 状态的 App API 一律 404（生命周期 guard），未认证请求一律 401（认证 guard，紧随其后）。Core 公开路由仅 `/api/core/health/*`、`/api/core/platform`、`/api/core/time` 与登录；其余 Core 路由需会话（应用启停、settings 写入与用户管理需管理员）。
- 列表统一 `{ items: [...] }`。
- 写接口必须提供 JSON Schema 校验；日志不记录请求体。
- 更新使用 PATCH，nullable 字段语义固定：缺省=不修改、显式 `null`=清空、有值=更新。
- 列表查询支持 `q` / 过滤 / `sortBy` / `order`；`sortBy` 必须使用代码内显式 allowlist 映射列名，禁止把请求参数拼接进 SQL。
- DATE 列以 `YYYY-MM-DD` 字符串穿越 API（避免时区偏移）；timestamptz 以 ISO UTC 存储、浏览器本地时区展示。

## 生命周期与关闭

- 状态语义：`enabled` 是用户期望（持久化在 `core.apps.enabled`），`status` 是实际运行状态（`enabled` / `disabled` / `error`）。激活失败保留用户意图：`enabled=true, status=error`，App Center 展示错误并提供 Retry / Disable；`PUT /enabled` 返回 registry 的最终状态，不会返回过期的 enabled 记录。
- 禁用 App：API 404、事件订阅与 Job 立即停止、前端隐藏；数据保留且 schema 继续升级。
- 优雅关闭顺序：停止接流量（`app.close`）→ 停 Job/退订 → 关数据库连接池。

## 测试矩阵

| 层 | 位置 | 内容 |
|---|---|---|
| 单元 | `backend/test/unit` | Manifest、扫描、配置、错误、存储路径安全、事件、调度、隔离静态检查 |
| 集成 | `backend/test/integration` | 迁移、注册表持久化、Core API、生命周期（含激活失败/迁移时序）、settings、三 App API |
| 前端 | `frontend/src/**/*.test.tsx` | App Center、Dashboard（顺序/导航/编辑模式）、presentation resolver、Assets/Tasks 编辑器与过滤、2048 逻辑 |
| E2E | `frontend/e2e`（Playwright） | 三 App 全生命周期、启停数据保留、Dashboard 排序/隐藏持久化、App 个性化持久化 |
| 验收 | `scripts/verify.sh` | 安装→检查→构建→测试→迁移→启动→健康检查→三 App 冒烟 |

### 测试如何通过认证

- **集成测试**：平台 API 全部需要会话。辅助函数在 `backend/test/helpers/platform.ts`：`ensureTestAdmin(db)` 激活测试管理员并返回其 id，`loginCookie(platform, …)` 走真实 `POST /api/core/auth/login` 返回 `pp_session=…` Cookie 串，之后以 `headers: { cookie }` 注入 `platform.app.inject(...)`。新写的集成测试一律复用这些辅助函数，不要绕过登录直改数据库会话。
- **E2E（Playwright）**：`frontend/e2e/auth.setup.ts` 以 bootstrap 管理员（`e2e-admin`）登录一次，把 HttpOnly 会话 Cookie 持久化为 storageState（`frontend/playwright/.auth/user.json`），e2e 项目通过 `storageState` 复用。后端由 `frontend/playwright.config.ts` 的 webServer 拉起并注入 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`；bootstrap 幂等且绝不重置已激活密码——复用的本地库若已用其他密码激活，登录会失败，应指向全新数据库或重新 bootstrap。
- 需要「另一个用户」的用例：集成测试用同文件的 `createTestUser(db, username, password)`（走 core auth service，可再 `loginCookie` 登录）；E2E 由管理员通过 `POST /api/core/auth/users` 创建。

## 本地无 Docker 跑法

```bash
# 一次性：初始化本地 PostgreSQL（示例：homebrew postgresql@17）
initdb -D /tmp/pp-pgdata -U pp --auth=trust
pg_ctl -D /tmp/pp-pgdata -o "-p 5439 -k /tmp/pp-pgdata -h 127.0.0.1" start
createdb -h 127.0.0.1 -p 5439 -U pp personal_platform
DATABASE_URL=postgresql://pp@127.0.0.1:5439/personal_platform npm run migration:up
DATABASE_URL=... npm run dev --workspace @personal-platform/backend
npm run dev --workspace @personal-platform/frontend   # 另一个终端
```

## Docker 网络默认值

默认 `docker compose up` 只把 frontend 绑定到宿主机 `127.0.0.1:5173`；database 与 backend 不发布宿主机端口（frontend 通过 compose 网络代理 `/api`）。需要数据库工具直连或 LAN 访问时使用 `make dev-expose`（= `docker/compose.expose.yml`：database/backend 发布到回环，frontend 开放全部网卡），或通过 `BIND_IP` / `EXPOSE_BIND_IP` 环境变量自定义绑定地址。CI 与 Playwright E2E 不依赖 compose 端口发布，不受该默认值影响。
