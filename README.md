# Personal Platform

面向个人使用的模块化 Web 平台。架构依据 [`doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md`](doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md)。

## 当前范围

当前只完成 **P0 Repository Bootstrap**：

- npm workspaces（Frontend / Backend）
- React + TypeScript + Vite 的 Web Shell 占位入口
- Fastify Backend 与存活、就绪检查
- PostgreSQL 与数据库连通性验证
- Docker Compose 开发环境
- 基础 GitHub Actions（类型检查与构建）
- 配置和环境变量模板

尚未实现 App Registry、App 生命周期、Dashboard、Widget、Migration、Storage、Event Bus、Scheduler 及三个验证 App。详见 [`doc/IMPLEMENTATION_PLAN.md`](doc/IMPLEMENTATION_PLAN.md)。

## 启动

前置条件：Docker Engine / Docker Desktop，支持 `docker compose`。

```bash
cp .env.example .env   # 可选；默认值可直接运行
make dev               # 等价于 docker compose up --build
```

启动后：

- Web Shell: <http://localhost:5173>
- Backend 存活检查: <http://localhost:8000/api/core/health/live>
- Backend 就绪检查: <http://localhost:8000/api/core/health/ready>
- PostgreSQL: `localhost:5432`

停止服务：

```bash
make down
```

首次启动成功的判断标准：`database`、`backend`、`frontend` 三个容器均为 healthy；Shell 页面显示 `Backend: online`。

## 本地质量检查

不使用容器时需安装 Node.js 22+：

```bash
npm ci
npm run check
npm run build
```

## 目录

```text
backend/             Fastify 后端进程
frontend/            React Web Shell
docker/              开发镜像
apps/                业务 App 边界（P0 暂无业务实现）
config/              非敏感平台配置
storage/             本地存储挂载点
doc/                 设计与实施文档
```

## 配置约定

- 密钥、密码和环境差异通过环境变量提供，不提交 `.env`。
- `config/platform.yaml` 只保存非敏感平台配置；P1 才实现其加载与校验。
- Compose 中的默认密码仅用于本地开发，不得用于生产。
