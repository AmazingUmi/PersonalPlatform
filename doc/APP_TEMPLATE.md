# App 开发模板

本文件说明如何用最小成本接入一个新 App，并形成「创建 → 注册 → 迁移 → 启用 → 展示」的完整闭环。

## 快速开始

```bash
npm run create:app -- assets "Asset Manager"
```

脚本会生成：

```text
apps/assets/
├── app.yaml          # 唯一元数据真源
├── migrations/       # 前向 SQL 迁移
└── README.md

backend/src/apps/assets/index.ts      # 后端模块（default export BackendAppModule）
frontend/src/apps/assets/index.tsx    # 前端模块（default export FrontendAppModule）
```

随后运行 `npm run generate:apps`（`create:app` 已自动执行）以刷新编译期模块表。

## 清单

1. **Manifest**（`apps/<id>/app.yaml`）：`manifest_version: 1`，`id` 只允许小写字母/数字/下划线，`frontend.route` 必须位于 `/<id>` 下。
2. **迁移**：在 `apps/<id>/migrations/` 下新增 `<timestamp>-<name>.sql`（前向 SQL）。执行 `npm run migration:up`。
3. **后端**：`backend/src/apps/<id>/index.ts` 默认导出 `BackendAppModule`，实现 `registerApi(ctx)`；按需实现 `registerEvents` / `registerJobs` / `healthcheck`。
4. **前端**：`frontend/src/apps/<id>/index.tsx` 默认导出 `FrontendAppModule`，提供 `routes`（相对路径）与可选 `widgets`。
5. **验证**：`npm run check && npm test && npm run test:integration`。

## 契约速览

```ts
// backend
interface BackendAppModule {
  id: string;
  registerApi(ctx: AppContext): Promise<void>;
  registerEvents?(ctx: AppContext): Promise<Unsubscribe[]>;
  registerJobs?(ctx: AppContext): Promise<JobHandle[]>;
  healthcheck?(ctx: AppContext): Promise<AppHealth>;
}

// frontend
interface FrontendAppModule {
  id: string;
  routes: AppRoute[];         // path 相对 App 根，"" 表示 App 首页
  widgets?: WidgetDefinition[]; // id 必须与 app.yaml 中声明的 widget id 一致
}
```

## 约束

- App 只通过 `AppContext` 使用 logger / database / storage / events / scheduler。
- App 不跨 Schema 写数据，不 import 其他 App 的 repository。
- 禁用不等于卸载：禁用只停止 API / Widget / 事件 / 任务，Schema 与数据保留。
- 事件名形如 `<app_id>.<entity>.<action>.v1`。
