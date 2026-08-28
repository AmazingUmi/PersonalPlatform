# Personal Platform — 项目初始化设计规划

> Version: v0.1  
> Status: Initial Design  
> Architecture: B/S + Modular Monolith

---

## 1. 项目目标

Personal Platform 是一个面向个人使用的通用 Web 应用平台。

平台提供统一的基础设施和运行框架，不绑定具体业务。物品管理、健康管理、待办、科研工具、小游戏等功能均作为独立 App 接入。

核心目标：

- 统一数据库、配置、存储、日志等基础设施
- 支持不同类型 App 快速接入
- App 可独立启用、禁用和维护
- 提供统一 Web 入口和主 Dashboard
- App 可提供独立页面，也可提供 Dashboard Widget
- 保持模块隔离，避免形成单一“大业务系统”
- 为后续 AI、自动化、跨 App 通信和独立服务扩展留出接口

非目标：

- v0.1 不采用微服务
- 不设计万能业务数据表
- 不要求所有 App 使用相同业务模型
- 不在初期实现复杂插件热加载
- 不追求多租户、企业权限体系

---

## 2. 核心设计原则

1. **B/S 架构**
2. **Modular Monolith 优先**
3. **Core 与业务 App 严格分离**
4. **共享基础设施，不共享业务模型**
5. **App 独立 Schema 和 Migration**
6. **App 可独立 Enable / Disable**
7. **Full Page + Optional Widget**
8. **统一 Web Shell**
9. **App 间优先通过 Event Bus 通信**
10. **复杂模块未来允许拆为独立服务**
11. **先构建最小平台能力，再扩充业务功能**
12. **平台能力必须由至少两类 App 的真实需求驱动**

---

## 3. 总体架构

```text
Browser
   │
   ▼
Web Shell
   ├── Dashboard
   ├── App Router
   ├── App Center
   ├── Settings
   └── Widgets
   │
   ▼
Backend
   ├── Core
   └── Apps
   │
   ├── Event Bus
   ├── Scheduler
   ├── Storage
   └── Database
   │
   ▼
PostgreSQL / File Storage
```

部署初期保持简单：

```text
Browser
   ↓
Frontend
   ↓
Backend
   ↓
PostgreSQL
   ↓
Local / Object File Storage
```

---

## 4. 平台分层

### 4.1 Web Shell

负责统一用户入口：

- 主导航
- Dashboard
- App 路由
- App Center
- Settings
- Widget 布局
- 公共 UI 组件
- 全局错误处理

Shell 不包含具体业务逻辑。

---

### 4.2 Core

Core 提供所有 App 可复用的基础能力：

```text
core/
├── app_registry
├── config
├── database
├── storage
├── events
├── scheduler
├── logging
├── api
└── healthcheck
```

v0.1 Core 最低能力：

| 模块 | 职责 |
|---|---|
| App Registry | App 注册、状态、Manifest |
| Config | 平台和 App 配置 |
| Database | 数据库连接和事务基础设施 |
| Storage | 文件存储统一接口 |
| Event Bus | App 间事件发布/订阅 |
| Scheduler | 定时任务注册与执行 |
| Logging | 统一日志 |
| API | 公共 API 规范 |
| Healthcheck | 平台和 App 状态检查 |

---

### 4.3 Apps

每个 App 是独立业务模块。

示例：

```text
apps/
├── assets/
├── tasks/
├── health/
├── research/
└── game_2048/
```

App 可以只实现自身需要的能力。

例如：

```text
Assets
├── Backend
├── Full Page
└── Widgets

Game
├── Backend
├── Full Page
├── Static Assets
└── Save Data
```

---

## 5. App 标准结构

推荐统一结构：

```text
apps/<app_id>/
├── app.yaml
├── backend/
│   ├── api/
│   ├── models/
│   ├── services/
│   ├── events/
│   └── jobs/
├── frontend/
│   ├── pages/
│   ├── widgets/
│   └── components/
├── migrations/
├── tests/
└── README.md
```

并非所有目录都必须存在。

---

## 6. App Manifest

每个 App 必须提供 `app.yaml`。

示例：

```yaml
id: assets
name: Assets
version: 0.1.0
description: Personal asset management

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

Manifest 用途：

- App 注册
- 路由注册
- Widget 注册
- 能力声明
- 状态检查
- 版本管理
- 后续依赖管理

---

## 7. App 生命周期

v0.1 定义四种状态：

```text
Installed
Enabled
Disabled
Error
```

语义：

### Installed

App 已存在于平台中。

### Enabled

App 正常加载：

- 注册 API
- 注册页面
- 注册 Widget
- 注册事件监听
- 注册定时任务

### Disabled

App 保留但不运行：

- 不显示主导航入口
- 不注册业务 API
- 不运行后台任务
- 不加载 Widget
- 数据继续保留

### Error

App 加载或运行异常。

重要原则：

```text
Disable != Uninstall
```

---

## 8. 前端设计

### 8.1 路由

建议基础路由：

```text
/                 Dashboard
/apps             App Center
/settings         Platform Settings

/assets
/tasks
/health
/games/*
```

---

### 8.2 Full Page

每个 App 可以提供完整页面。

例如：

```text
/assets
/assets/items/123

/tasks

/games/2048
```

App 页面由统一 Shell 包裹。

---

### 8.3 Widget

App 可选择提供 Widget：

```text
Tasks Today
Asset Summary
Health Summary
Game Status
System Status
```

Dashboard 是 Widget 容器，而不是独立业务模块。

未来可以支持：

- Widget 添加/删除
- 拖拽
- Resize
- 用户布局持久化
- 多 Dashboard

v0.1 只需固定布局或简单配置布局。

---

## 9. 后端设计

v0.1 使用模块化单体。

```text
backend/
├── core/
└── apps/
```

运行时：

```text
1 Backend Process
+
1 PostgreSQL
```

优点：

- 部署简单
- 调试简单
- 数据库事务直接
- 模块间接口清晰
- 后续仍可拆服务

不建议 v0.1 为每个 App 单独启动后端服务。

---

## 10. API 规范

统一 API 前缀：

```text
/api/core/*
/api/apps/<app_id>/*
```

例如：

```text
GET /api/core/apps

GET /api/apps/assets/items

POST /api/apps/tasks/tasks
```

要求：

- Core API 与 App API 分离
- App 不直接暴露 Core 内部实现
- 返回结构和错误格式统一
- 所有 App 使用统一日志与异常处理中间件

---

## 11. 数据库设计

使用 PostgreSQL。

推荐 Schema 级隔离：

```text
core.*
assets.*
tasks.*
health.*
game_2048.*
```

示例：

```text
core.apps
core.settings
core.events

assets.items
assets.categories

tasks.tasks

health.records
health.metrics

game_2048.saves
```

原则：

> 共享 PostgreSQL 实例，但业务表归各 App 所有。

禁止设计：

```text
entities
objects
records
```

作为承载全部业务的万能表。

允许 App 自己决定：

- 表结构
- 索引
- 关系
- JSONB 使用
- 数据生命周期

---

## 12. Migration

每个 App 独立维护 Migration：

```text
apps/assets/migrations/
apps/tasks/migrations/
```

要求：

- Core Migration 与 App Migration 分离
- App 禁用时不删除数据
- App 升级时支持 Schema Migration
- Migration 应可追踪版本

---

## 13. 文件存储

Core 提供统一 Storage API。

App 不直接绑定具体存储实现。

接口概念：

```text
save()
read()
delete()
list()
```

v0.1 可使用本地目录：

```text
storage/
├── core/
└── apps/
    ├── assets/
    ├── health/
    └── game_2048/
```

未来可切换至：

- S3
- MinIO
- NAS
- Cloud Object Storage

业务代码不应依赖具体存储后端。

---

## 14. Event Bus

App 间通信优先使用事件。

例如：

```text
health.exercise.completed
tasks.task.completed
assets.item.created
game.achievement.unlocked
```

流程：

```text
App A
  ↓ publish
Event Bus
  ↓ subscribe
App B
```

规则：

- App 不应直接修改其他 App 的数据库表
- Event 名称需要 namespace
- Event payload 保持简单、版本可控
- Event Bus v0.1 可采用进程内实现

后续需要时再替换为外部消息系统。

---

## 15. Scheduler

平台提供统一定时任务能力。

App 可注册：

```text
daily
weekly
cron
one-shot
```

例如：

```text
health.daily_summary
assets.warranty_check
tasks.cleanup
```

v0.1 只需支持基本后台定时任务。

---

## 16. 配置系统

配置分两层：

```text
Platform Config
App Config
```

例如：

```text
config/
├── platform.yaml
└── apps/
    ├── assets.yaml
    └── tasks.yaml
```

运行时可逐步迁移到数据库。

敏感信息不得直接提交 Git。

---

## 17. App Center

平台提供 App 管理页面：

```text
Apps
────────────────

Assets       Enabled
Tasks        Enabled
Health       Disabled
2048         Enabled
```

v0.1 支持：

- 查看 App
- Enable
- Disable
- 查看版本
- 查看状态

后续扩展：

- Install
- Uninstall
- Upgrade
- Export
- Import
- Dependency Management

---

## 18. 推荐仓库结构

```text
personal-platform/
├── backend/
│   ├── core/
│   ├── apps/
│   └── main.*
│
├── frontend/
│   ├── shell/
│   ├── shared/
│   ├── apps/
│   └── main.*
│
├── apps/
│   ├── assets/
│   ├── tasks/
│   └── mini_game/
│
├── config/
├── storage/
├── migrations/
├── tests/
├── scripts/
├── docker/
├── docs/
├── .env.example
├── docker-compose.yml
├── README.md
└── AGENTS.md
```

实际实现时可根据前后端技术栈调整，但模块边界应保持不变。

---

## 19. v0.1 验证 App

第一阶段只实现三个 App。

### Assets

验证：

- CRUD
- 数据库
- 搜索
- 文件附件
- Widget

### Tasks

验证：

- 状态管理
- 时间字段
- 查询过滤
- Scheduler
- Event

### Mini Game

验证：

- 非 CRUD 类业务
- 前端交互
- 静态资源
- 游戏存档
- App 独立页面

三个 App 差异足够大，可用于检验平台抽象是否合理。

---

## 20. v0.1 开发阶段

### P0 — Repository Bootstrap

完成：

- 仓库结构
- 前后端项目
- PostgreSQL
- Docker Compose
- 基础 CI
- 配置模板

验收：

- 一条命令启动开发环境
- Frontend / Backend / DB 均正常

---

### P1 — Core Skeleton

完成：

- App Registry
- Config
- Database
- Logging
- Healthcheck

验收：

- Core 可启动
- 能读取 App Manifest
- 能返回 App 列表

---

### P2 — App Lifecycle

完成：

- Enabled / Disabled
- Backend 模块注册
- Frontend 路由注册
- App Center

验收：

- App 可通过配置启停
- Disabled App 不加载业务功能
- 数据保留

---

### P3 — Dashboard & Widget

完成：

- Dashboard
- Widget Registry
- App Widget 注册
- 基础布局

验收：

- 不同 App Widget 可同时显示
- Disabled App Widget 自动消失

---

### P4 — Shared Services

完成：

- Storage
- Event Bus
- Scheduler

验收：

- App 可通过统一接口使用三项能力
- App 间无需直接访问彼此数据库

---

### P5 — Validation Apps

实现：

```text
Assets
Tasks
Mini Game
```

重点不是功能丰富，而是验证平台抽象。

---

### P6 — v0.1 Stabilization

完成：

- 测试
- 错误处理
- Backup
- Migration 流程
- 基础文档
- 开发者 App 模板

最终形成：

```text
Create App
→ Register
→ Develop
→ Enable
→ Display
```

完整闭环。

---

## 21. v0.1 验收标准

平台达到以下条件即可认为 v0.1 架构成立：

- [ ] 浏览器统一访问
- [ ] Web Shell 独立于业务 App
- [ ] Core 不包含具体业务逻辑
- [ ] App 可自动注册
- [ ] App 可 Enable / Disable
- [ ] App 支持独立页面
- [ ] App 可提供 Widget
- [ ] Dashboard 可组合多个 App Widget
- [ ] PostgreSQL Schema 隔离
- [ ] App 独立 Migration
- [ ] 统一 Storage
- [ ] 基础 Event Bus 可用
- [ ] 基础 Scheduler 可用
- [ ] Assets 接入成功
- [ ] Tasks 接入成功
- [ ] Mini Game 接入成功
- [ ] App 禁用不会造成数据丢失
- [ ] 开发环境可一条命令启动

---

## 22. 暂不实现

以下内容推迟到 v0.2+：

- 微服务
- Kubernetes
- 分布式 Event Bus
- 动态远程插件市场
- 多用户复杂权限
- OAuth Provider 集成
- 实时协作
- Native Mobile App
- AI Agent 深度集成
- 跨节点分布式部署
- App 在线安装
- 自动依赖解析

---

## 23. 后续演进方向

平台稳定后可逐步加入：

```text
Personal Platform
├── Assets
├── Tasks
├── Health
├── Research
├── Finance
├── Games
├── Home
├── AI Tools
└── Custom Apps
```

基础设施可以进一步扩展：

```text
Search
Notification
AI Gateway
Backup
Auth
Secrets
Metrics
Automation
External API Integration
```

必要时允许独立服务：

```text
Main Platform
   ├── Modular Apps
   ├── AI Service
   ├── Compute Service
   └── Game Service
```

但是否拆分应由真实需求决定。

---

## 24. 项目初始化决策

v0.1 默认遵循：

```text
Architecture:
B/S + Modular Monolith

Frontend:
Single Web Shell

Backend:
Single Main Backend

Database:
PostgreSQL

Isolation:
Schema per App

App UI:
Full Page + Optional Widgets

App Communication:
Event Bus

Deployment:
Docker Compose

Development Strategy:
Core First + Three Validation Apps
```

项目初始化后的首要目标不是完善具体业务，而是建立：

> **一个新 App 能以低成本接入、运行、展示、存储数据并独立启停的最小完整平台。**
