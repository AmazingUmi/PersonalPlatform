# Docker 开发与生产部署

## 目标与当前缺口

保留 Compose 一键开发，提供独立、可验证的生产部署。当前生产 overlay 的构建路径、源码挂载清理和后端入口错误；前端使用 Vite preview；没有镜像构建、真实代理和持久化启动门禁。

## 决策

- 开发继续使用根目录 `docker-compose.yml`、源码挂载及 watch；生产单独使用 `docker/docker-compose.prod.yml`，不与开发文件合并，默认项目名和数据卷独立。
- 后端 Node 22 多阶段构建，运行层仅含编译结果、生产依赖、配置、manifest 和 SQL migration；非 root，以 `/workspace/backend/dist/main.js` 启动。入口在容器内编码数据库凭据，支持 URL 特殊字符。
- 前端多阶段构建后交给非 root Nginx，监听 8080；同源代理 `/api/`，支持 SPA 深链接、静态资源缓存和真实 API 404；上传限制覆盖现有 10 MiB 附件能力。
- PostgreSQL 与附件使用命名卷。镜像预建属于 node 的 storage 目录，验证全新卷写入及容器重建后的数据保留。
- 生产固定 production 环境，Cookie 默认 Secure；HTTP 冒烟显式覆盖，另测默认 Secure。仅前端发布回环端口。Nginx 覆盖客户端伪造的转发 IP；外层 TLS 代理的真实 IP 配置另作明确说明。
- 生产凭据没有开发默认值；独立示例环境文件、Make 入口、部署/升级说明。旧部署迁移需备份、停写、明确映射原数据库卷并复制附件，禁止以新卷替代旧数据。

## 任务与依赖

1. 架构方案 → worklist reviewer checkpoint → 冻结本清单。
2. Compose、镜像、Nginx、入口及环境文件；保留开发路径。
3. 无 daemon 的配置回归；真实镜像 build/boot、迁移、登录、代理、附件上传/下载、容器重建验证；隔离随机项目/端口/卷，失败输出日志并清理自身资源。
4. CI 独立 Docker job 运行同一验证入口；更新 Makefile、README、开发及部署文档。
5. canonical gates 与独立 final-reviewer。已知 auth-isolation 的固定日期/真实时钟测试若仍阻塞集成验收，仅补 fixture clock，不改业务行为。

## 允许范围与非目标

允许：`docker/**`、`docker-compose.yml`、`.dockerignore`、`.env*.example`/对应 ignore、`scripts/` 的 Docker 验证及其测试、`package.json`、`Makefile`、`.github/workflows/**`、部署相关文档、本清单；必要时只修 `backend/test/integration/auth-isolation.test.ts` 的固定时钟。

不修改 Core、App Contract V1、历史迁移、App 业务、备份恢复实现、前端界面。不开公网部署，不发布镜像，不自动 commit/push。

## 验收与回归矩阵

| 层级 | 标准 |
|---|---|
| 配置 | dev 保留 bind/watch；prod 单文件正确 context，无源码 bind，仅前端端口，缺失凭据拒绝 |
| 镜像 | 构建不依赖宿主 dist/node_modules；后端正确入口/无 dev 工具，前端仅静态服务；非 root |
| 启动 | 全新数据库/附件卷，全部已安装 App 正常，健康检查与真实登录成功 |
| 代理 | 页面与深链接200；hash资源正确类型；缺失资源404；API404保持JSON；默认Secure登录cookie |
| 存储 | 经Nginx上传大于1MiB附件、下载字节一致；容器重建后数据库/附件仍在 |
| 失败 | Docker不可用/构建/启动/断言失败均非零；清理仅当前随机验证项目及其卷 |
| 工程 | check、build、unit、integration、E2E、verify、diff检查；独立终审；GitHub CI未执行时明确标注 |

## 状态

- 架构方案：ACCEPTED。
- Worklist checkpoint：ACCEPTED；2026-10-22 冻结，backend reviewer 确认范围及验收矩阵。
- 实现：完成；无 Core、业务代码或历史迁移变更。
- 本地配置回归：4/4 PASS；生产镜像构建、启动及持久化验证 PASS。
- Canonical verify：check/build、后端188、前端418、集成325、迁移与后端冒烟全部 PASS；E2E 42/42 PASS。
- 独立终审：ACCEPTED，本地验收通过；用户已授权提交本批，GitHub Actions 待推送后触发。

## 实施中事实修订

- reviewer 发现默认构建资源路径 `/assets/` 与真实 App 深链接 `/assets/items/:id` 冲突。生产构建改用 `/_static/`（不占用合法 App id），验证新增 Assets 详情深链接；不改变开发构建或 App 路由。
- canonical E2E 暴露既有 Mini Game 测试错误：断言移动后非空 tile 数不减少，但合法合并可减少（本次 7→6）。为解除验收阻塞，范围仅扩展到 `frontend/e2e/platform.spec.ts` 的该用例：真实 API 建立确定棋盘，验证合并/生成后的结果和存档刷新持久化；不改游戏逻辑，不以随机重跑代替修复。
