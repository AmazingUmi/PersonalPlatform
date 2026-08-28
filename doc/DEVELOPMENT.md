# 开发指南

面向在本仓库开发的贡献者。架构与范围见 [`PERSONAL_PLATFORM_INITIAL_DESIGN.md`](PERSONAL_PLATFORM_INITIAL_DESIGN.md)，阶段计划见 [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)，新 App 接入见 [`APP_TEMPLATE.md`](APP_TEMPLATE.md)。

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

npm run migration:up        # Core + 已启用 App 的迁移
npm run migration:status    # 各 scope 已应用迁移
npm run migration:create -- --scope assets --name add_items

npm run create:app -- my_app "My App"   # 从模板创建新 App
npm run backup              # 备份数据库（backup.sh backup|restore）
npm run verify              # 本地完整验收（见 scripts/verify.sh）
```

## 数据库

- 开发库连接串由 `DATABASE_URL` 提供（`.env` / 环境变量，不提交）。
- 集成测试默认使用 `TEST_DATABASE_URL`（默认 `...127.0.0.1:5439/personal_platform_test`），每个测试文件会清空全部业务 schema 并重放 Core 迁移。
- Schema 隔离：Core 用 `core`，每个 App 用自己的 `<app_id>` schema；App 只能写自己的 schema（有静态检查测试 `backend/test/unit/isolation.test.ts`）。
- 迁移执行顺序：Core → 已启用 App（按 id 排序）；禁用 App 不迁移、不删表。详见 [`MIGRATION_RUNBOOK.md`](MIGRATION_RUNBOOK.md)。

## 后端结构

```text
backend/src/
├── core/               # 平台核心，不含业务逻辑
│   ├── api/            # /api/core/* 路由 + 统一错误
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

App 通过 `AppContext` 获得 `api`（前缀 `/api/apps/<id>`，受生命周期 guard 保护）、`database`、`storage`（根目录 `storage/apps/<id>`）、`events`、`scheduler`、`log`。App 之间不互相 import、不跨 schema 写数据。

## 前端结构

```text
frontend/src/
├── shell/              # 导航、路由、Dashboard、App Center、Settings
├── shared/             # api 客户端、类型、ErrorBoundary、useAsync（无业务逻辑）
├── apps/<id>/          # 各 App 页面与 Widget（default export）
└── generated/apps.ts   # 生成文件，勿手改
```

Shell 用 `GET /api/core/apps` 的启用状态与编译期模块表求交集：禁用的 App 自动从导航、路由与 Dashboard Widget 中消失。Widget 布局持久化在 `core.settings`（key `dashboard.widgets`）。

## API 约定

- Core：`/api/core/*`；App：`/api/apps/<app_id>/*`。
- 错误统一 `{ error: { code, message, requestId, details? } }`；非 enabled 状态的 App API 一律 404。
- 列表统一 `{ items: [...] }`。
- 写接口必须提供 JSON Schema 校验；日志不记录请求体。

## 生命周期与关闭

- 禁用 App：API 404、事件订阅与 Job 立即停止、前端隐藏；数据保留。
- 优雅关闭顺序：停止接流量（`app.close`）→ 停 Job/退订 → 关数据库连接池。

## 测试矩阵

| 层 | 位置 | 内容 |
|---|---|---|
| 单元 | `backend/test/unit` | Manifest、扫描、配置、错误、存储路径安全、事件、调度、隔离静态检查 |
| 集成 | `backend/test/integration` | 迁移、注册表持久化、Core API、生命周期、settings、三 App API |
| 前端 | `frontend/src/**/*.test.tsx` | App Center、Dashboard Widget、ErrorBoundary、路由过滤 |
| 验收 | `scripts/verify.sh` | 安装→检查→构建→测试→迁移→启动→健康检查→三 App 冒烟 |

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
