# Personal Platform — 具体实现方案

> 基线：`PERSONAL_PLATFORM_INITIAL_DESIGN.md` v0.1  
> 当前状态：P0、P1 已完成；P2–P6 实施中  
> 原则：先验证平台闭环，不提前实现 v0.2 能力

## 1. 范围控制

本次初始化只交付 P0：仓库、前后端最小进程、PostgreSQL、Docker Compose、配置模板和基础 CI。P0 页面只用于验证 Browser → Frontend → Backend → Database 链路。

以下能力仅在本文中设计，不在 P0 预实现：App Registry、启停、Dashboard、Widget、Migration、Storage、Event Bus、Scheduler、Assets、Tasks、Mini Game。

## 2. 技术决策

| 层 | 选择 | 原因 |
|---|---|---|
| Runtime | Node.js 22 LTS | 前后端统一语言，减少初始化工具链 |
| Backend | Fastify + TypeScript | 轻量、插件边界明确、Schema/日志支持好 |
| Frontend | React + TypeScript + Vite | 适合单 Shell 与编译期 App 模块组合 |
| Database | PostgreSQL 17 | 支持 Schema 隔离、JSONB、事务 |
| DB driver | `pg` | P0 只需连接与事务，不提前绑定 ORM |
| Manifest | YAML + JSON Schema 校验 | 便于人读，同时保证注册契约 |
| Migration | `node-pg-migrate`（P1 引入） | 可编程运行，支持每个 Schema 独立迁移目录 |
| Test | Node test runner + Fastify inject；前端 Vitest | 轻量且覆盖接口和组件 |
| Deployment | Docker Compose | 保持单后端进程、单数据库的 v0.1 目标 |

暂不引入 Nx/Turborepo、Kubernetes、Redis、外部消息队列、远程插件加载和完整 UI 组件库。

## 3. 模块落位

```text
backend/src/
├── core/
│   ├── api/              # /api/core/*
│   ├── app-registry/
│   ├── config/
│   ├── database/
│   ├── events/
│   ├── health/
│   ├── logging/
│   ├── scheduler/
│   └── storage/
├── apps/<app_id>/        # App 后端适配与业务代码
├── generated/apps.ts     # 构建脚本生成的静态模块表
└── main.ts

frontend/src/
├── shell/                # 导航、路由、Dashboard、App Center、Settings
├── shared/               # 通用 UI/API 客户端；不得包含业务规则
├── apps/<app_id>/        # App 页面、Widget、组件
├── generated/apps.ts     # 构建脚本生成的静态模块表
└── main.tsx

apps/<app_id>/
├── app.yaml              # 唯一 Manifest
├── migrations/           # App 自己的数据库迁移
├── tests/                # 跨前后端/契约测试
└── README.md
```

`apps/<app_id>/app.yaml` 是元数据真源；可执行代码随单体一起编译。构建脚本校验 Manifest，并生成前后端静态 import 表。该方案支持模块启停，但明确不做运行时下载或执行未知代码。

## 4. 核心契约

### 4.1 Manifest v1

```yaml
manifest_version: 1
id: assets
name: Assets
version: 0.1.0
description: Personal asset management
default_enabled: true
frontend:
  route: /assets
widgets:
  - id: summary
    name: Asset Summary
capabilities:
  database: true
  storage: true
  scheduler: false
  events: true
```

校验规则：

- `id` 只允许小写字母、数字和下划线，且全局唯一。
- 路由必须位于 `/<app_id>` 下；API 固定为 `/api/apps/<app_id>`。
- Widget ID 在 App 内唯一。
- Manifest 版本不支持时，App 状态记为 `Error`，平台继续启动。
- 能力声明用于审计和测试，不作为安全沙箱。

### 4.2 后端 App 接口

```ts
interface BackendAppModule {
  id: string;
  registerApi(ctx: AppContext): Promise<void>;
  registerEvents?(ctx: AppContext): Promise<Unsubscribe[]>;
  registerJobs?(ctx: AppContext): Promise<JobHandle[]>;
  healthcheck?(ctx: AppContext): Promise<AppHealth>;
}
```

`AppContext` 只暴露受控的 logger、数据库事务、Storage、Event Bus 和 Scheduler；App 不导入其他 App 的 repository，也不跨 Schema 写数据。

### 4.3 前端 App 接口

```ts
interface FrontendAppModule {
  id: string;
  routes: AppRoute[];
  widgets?: WidgetDefinition[];
}
```

Shell 从 Core API 获取启用状态，再与编译期模块表求交集。未知模块显示错误但不破坏 Shell。

### 4.4 API 与错误

- Core：`/api/core/*`
- App：`/api/apps/<app_id>/*`
- 成功响应按资源直接返回；分页统一 `{ items, page, pageSize, total }`。
- 错误统一 `{ error: { code, message, requestId, details? } }`。
- 禁用或不存在的 App 对外返回 404，避免暴露内部状态。
- 所有写接口验证 body/params，日志不得记录密码、Token 和文件内容。

## 5. 数据库方案

### 5.1 Schema

```text
core.apps
core.settings
core.event_log          # 仅在确有审计需求时加入
assets.*
tasks.*
mini_game.*
```

`core.apps` 至少包含：`id`、`version`、`status`、`enabled`、`error_message`、`installed_at`、`updated_at`。状态由发现结果和启用配置计算，不使用万能业务表。

### 5.2 连接与事务

- Core 持有唯一 `pg.Pool`，App 通过 `DatabaseContext` 获取 client。
- `withTransaction(fn)` 统一处理 begin/commit/rollback。
- 查询必须使用参数化 SQL。
- PostgreSQL role 在 v0.1 可共用；代码层禁止跨 App Schema，测试负责验证。

### 5.3 Migration

执行顺序：Core → Enabled Apps（按 App ID 稳定排序）。每个 Schema 使用自己的迁移目录和迁移记录表。迁移过程使用 PostgreSQL advisory lock，任一迁移失败则停止启动并报告具体 App；禁用 App 不回滚、不删表。

开发命令规划：

```bash
npm run migration:create -- --scope assets --name add_items
npm run migration:up
npm run migration:status
```

生产发布前必须备份；v0.1 只支持向前迁移，不承诺自动 downgrade。

## 6. 生命周期实现

1. 扫描 `apps/*/app.yaml`。
2. 校验 Manifest，合并 `default_enabled`、平台配置和 `core.apps` 持久状态。
3. 运行 Core 与已安装 App Migration。
4. 从编译期模块表装载代码。
5. 启用 App 时注册 API、事件监听和 Job；前端显示页面与 Widget。
6. 禁用时立即停止监听与 Job、隐藏 UI，并由统一 route guard 使 API 返回 404；数据不变。
7. 初始化或运行异常时记录为 `Error`，隔离该 App，Core 和其他 App 继续工作。

Fastify 的静态路由不会在运行中安全卸载，因此所有 App 路由在注册点增加统一 lifecycle guard。它在外部行为上满足“Disabled App 不提供业务 API”，同时避免为启停重启整个进程。

状态修改接口：

```text
GET  /api/core/apps
PUT  /api/core/apps/:id/enabled   { enabled: boolean }
GET  /api/core/apps/:id/health
```

更新采用事务并具备幂等性。启停失败时恢复先前状态并返回可诊断错误。

## 7. 共享服务

### Storage

定义 `save/read/delete/list`；Local driver 根目录固定为 `storage/apps/<app_id>`。标准化路径并拒绝 `..`、绝对路径和符号链接逃逸。接口预留 metadata，不在 P4 前实现 S3。

### Event Bus

进程内 typed pub/sub；事件名 `<app_id>.<entity>.<action>.v1`，Envelope 包含 `id/type/version/occurredAt/source/payload`。订阅异常只记录并隔离，不回滚发布者事务。需要事务一致性时再由真实需求引入 outbox，不在 v0.1 预建分布式消息系统。

### Scheduler

单进程调度器，Job ID 固定为 `<app_id>.<job>`。支持 cron 和 one-shot；禁用 App 时取消其 Job。任务必须幂等，记录开始、结束、耗时和错误。v0.1 单后端进程无需分布式锁。

## 8. 分阶段交付

### P0 — Repository Bootstrap（已完成）

交付：npm workspaces、Web Shell 占位页、Backend health、PostgreSQL、Compose、CI、配置模板。  
验收：`docker compose up --build` 后三服务 healthy；Shell 显示 Backend online；Backend 启动日志确认 `SELECT 1`。

### P1 — Core Skeleton（已完成）

- 拆分当前 `backend/src/main.ts` 为 config/database/health 模块。
- 实现 Manifest Schema、扫描器、编译期 registry 生成器。
- 建立 Core Migration 和 `core.apps`。
- 实现 `GET /api/core/apps` 与错误中间件。
- 增加单元、Manifest 契约和启动失败测试。

完成定义：有效/无效 Manifest 均有确定结果；数据库不可用时 readiness 503；单个坏 App 不拖垮 Core。  
验证：`npm run test`（backend 单元 21 项）、`npm run test:integration`（backend 集成 15 项，含迁移幂等、坏 App 隔离、readiness 503）。

### P2 — App Lifecycle & App Center（已完成）

- 实现启停状态机、route guard、事件/Job 清理句柄。
- 前端加入 React Router、导航和 App Center。
- 端到端验证 Enabled / Disabled / Error。

完成定义：禁用后导航、Widget、API 和后台任务均不可用，Schema 数据仍存在；重新启用后恢复。  
验证：`backend test/integration/lifecycle.test.ts`（7 项：API 404、Job 停止、数据保留、恢复、幂等、未知 App 404）；前端 Vitest 8 项（App Center 操作、路由过滤）。统一 route guard 对非 enabled 状态一律 404，不暴露内部状态。

### P3 — Dashboard & Widget（已完成）

- Widget Registry 由前端 App module 提供。
- Dashboard 使用固定响应式网格；布局先存 `core.settings`。
- 每个 Widget 设置 Error Boundary、loading/empty/error 状态。

完成定义：至少两个测试 Widget 可共存；禁用来源 App 后自动消失；单 Widget 异常不影响 Dashboard。  
验证：前端 Vitest 11 项（Widget 共存、禁用消失、错误隔离、core.settings 布局）；后端 settings API 集成测试（键校验、404、JSONB 往返）。新增 `GET/PUT /api/core/settings/:key`。

### P4 — Shared Services

- 实现 Local Storage driver、Event Bus 和 Scheduler。
- 为每项服务编写契约测试与一个最小示例。
- 明确关闭顺序：停止接流量 → 停 Job/订阅 → 关闭数据库。

完成定义：App 只通过 `AppContext` 使用共享服务，且不存在跨 App 数据库写入。

### P5 — Validation Apps

**Assets**：物品/分类 CRUD、搜索、附件、总数 Widget。  
**Tasks**：任务状态/截止时间/筛选、到期 Job、`tasks.task.completed.v1` 事件、今日 Widget。  
**Mini Game**：最小 2048 页面、静态资源、存档、当前最高分 Widget（可选）。

每个 App 只实现验证架构所需的 happy path、验证和错误处理，不扩展账户、复杂权限、导入导出或协作功能。

### P6 — Stabilization

- API/组件/E2E 测试和覆盖关键失败路径。
- 备份/恢复脚本，Migration runbook。
- App 模板生成脚本与开发文档。
- Compose 生产覆盖文件、资源限制、非 root 镜像和依赖安全扫描。

完成定义：从创建模板到注册、迁移、启用、页面展示、禁用形成完整闭环。

## 9. 测试矩阵

| 层 | 必测内容 |
|---|---|
| Unit | Manifest 校验、状态机、路径安全、事件取消、事务回滚 |
| API | 统一错误、Core/App 前缀、禁用 404、CRUD 校验 |
| Integration | PostgreSQL Schema 隔离、Migration 幂等、数据保留 |
| Frontend | 路由过滤、Widget Error Boundary、App Center 操作 |
| E2E | 启动 → 启用 App → 写数据 → 禁用 → 重启 → 数据恢复 |
| Operational | readiness、优雅关闭、备份恢复、坏 App 隔离 |

CI 演进顺序：P0 类型检查/构建；P1 加单元测试和 PostgreSQL service；P2 加前端测试；P5 加 Playwright E2E。任何阶段不为了覆盖率数字创建无行为价值测试。

## 10. 实施顺序与变更粒度

建议每阶段拆成可独立回滚的变更：

1. Core 目录重构与配置校验。
2. Migration 基础设施和 Core Schema。
3. Manifest/Registry 与只读 Apps API。
4. Lifecycle 与 App Center。
5. Widget Registry 与 Dashboard。
6. Storage、Event Bus、Scheduler 各自独立提交。
7. 三个验证 App 分别接入。
8. 稳定化与 App 模板。

每个变更必须同时更新相关契约测试和本文状态；若两个真实 App 尚无共同需求，不把新能力提升为 Core 抽象。

## 11. P0 验收命令

```bash
cp .env.example .env
npm ci
npm run check
npm run build
docker compose up --build
curl -fsS http://localhost:8000/api/core/health/live
curl -fsS http://localhost:8000/api/core/health/ready
curl -fsS http://localhost:5173
```

当前环境若无 Docker，只能完成 npm 类型检查和构建；Compose 健康状态需在安装 Docker 后按以上命令复验。
