# Docker 开发与生产部署

开发与生产使用独立的 Compose 文件。生产文件**单独运行**，不要与根目录开发文件合并。

| 场景 | 入口 | 运行方式与数据 |
|---|---|---|
| 开发 | `make dev` | `docker-compose.yml`；源码 bind mount、tsx/Vite 热更新；附件在宿主 `storage/` |
| 开发调试端口 | `make dev-expose` | 额外发布数据库与后端回环端口，前端可供 LAN 访问 |
| 生产 | `make prod` | `docker/docker-compose.prod.yml`；编译后 Node + Nginx；数据库、附件独立命名卷 |
| 本地开发 | 见 [DEVELOPMENT.md](DEVELOPMENT.md#本地无-docker-跑法) | Node 与 PostgreSQL 直接运行，Docker 可选 |

## 首次生产启动

要求 Docker Engine 与 Docker Compose v2.20+，以下命令均在仓库根目录执行。

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# 编辑 .env.production，填写数据库密码和首个管理员密码。
make prod
make prod-ps
make prod-logs
```

`POSTGRES_PASSWORD`、`BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD` 必填，没有可登录的默认密码。env 文件中包含 `$`、`#` 或空白的值使用单引号。数据库连接 URL 由容器入口逐段编码，密码可包含 URL 特殊字符。

生产默认项目为 `personal-platform-production`，与开发的 `personal-platform` 分离。默认只发布 `127.0.0.1:5173`；后端和数据库不发布宿主端口。前端容器监听 8080，Nginx 同源转发 `/api/`，其他页面支持 SPA 深链接。

默认 `PLATFORM_ENVIRONMENT=production` 且登录 Cookie 带 `Secure`。正式使用时将前端放在 HTTPS 反向代理后。若只进行已知的本机 HTTP 验证，可临时显式设置 `SESSION_COOKIE_SECURE=false`；验证后恢复 true。

Nginx 覆盖客户端传入的 `X-Forwarded-For`，后端默认信任内部私网代理。若前面还有 TLS 代理，默认看到的是该代理的地址；需要按真实拓扑在 Nginx 配置中指定可信代理 CIDR 和 real-IP 规则，再构建镜像，不能直接信任任意客户端提供的头。

自定义项目名、端口和凭据写在 `.env.production`；可用 `make PROD_ENV=/path/to/private.env prod` 指定其他文件。自定义 `config/` 在构建前修改并审阅，生产默认不挂载宿主源码或配置。构建上下文排除环境密钥、备份和测试认证文件。

## 运行资源配置

生产部署默认采用小规模自部署参数，VPS、Linux 服务器和 NAS 使用同一套配置。所有 App、用户共用一个数据库连接池，减少连接数不会移除账户隔离或更改事务行为。

| 环境变量 | 生产默认值 | 含义 |
|---|---|---|
| `DATABASE_POOL_MAX` | `4` | 后端共享连接池上限；整数 1–100，显式空值或非法值会在启动时失败 |
| `PG_SHARED_BUFFERS` | `64MB` | PostgreSQL 共享缓冲区 |
| `PG_WORK_MEM` | `2MB` | PostgreSQL 单个排序/哈希等执行操作的基础工作内存，并非整个数据库上限 |
| `PG_MAINTENANCE_WORK_MEM` | `32MB` | PostgreSQL 维护工作内存 |
| `PG_MAX_CONNECTIONS` | `30` | 数据库连接上限，须为应用池之外的迁移、管理员和维护连接留余量 |
| `HEALTHCHECK_INTERVAL` | `30s` | 三个容器的健康检查周期 |
| `DATABASE_MEMORY_LIMIT` / `DATABASE_CPU_LIMIT` | `1G` / `1.0` | 数据库容器资源上限 |
| `BACKEND_MEMORY_LIMIT` / `BACKEND_CPU_LIMIT` | `512M` / `1.0` | 后端容器资源上限 |
| `FRONTEND_MEMORY_LIMIT` / `FRONTEND_CPU_LIMIT` | `256M` / `0.5` | 前端容器资源上限 |

这些资源上限不是预留量或最低硬件要求。降低上限本身不代表内存优化；上限过低可能导致 OOM 或请求排队，需在目标机器和数据量下验证。PostgreSQL 的文件缓存、连接以及并发查询仍会消耗额外内存。`fsync`、`synchronous_commit` 和正常 WAL 恢复能力保持开启。

需要恢复之前的连接/数据库配置时，可设置 `DATABASE_POOL_MAX=10`、`PG_SHARED_BUFFERS=128MB`、`PG_WORK_MEM=4MB`、`PG_MAINTENANCE_WORK_MEM=64MB`、`PG_MAX_CONNECTIONS=100`。修改这些运行参数后使用 `make prod` 重建/重建容器即可复用已有数据卷，无需 SQL 迁移。直接运行后端或构造 `Database` 而未配置池容量的调用方仍默认 10；`DATABASE_POOL_MAX` 仅由后端启动入口显式解析。

后端探针使用镜像内 BusyBox `wget`，不再为每次探测启动 Node。HTTP 错误、连接失败和超时均判为失败。默认 30 秒周期、连续 10 次失败意味着故障判定名义窗口约 300 秒，原来 5 秒周期约 50 秒；实际还受超时和启动宽限期影响。可设置 `HEALTHCHECK_INTERVAL=5s` 恢复较快发现，代价是更频繁唤醒。首次启动仍使用 180 秒等待门禁，健康状态本身不会让 Docker 自动重启一个仍在运行的进程。

三个生产服务均使用 `json-file` 日志轮转，每个文件最多 `10m`、保留 3 个文件。后端仍默认 `INFO`；希望减少请求日志写入时可以显式设置 `LOG_LEVEL=warn`，错误日志仍保留。开发配置保持原有热更新行为。多架构预构建镜像发布尚未包含在这一批，目前 `make prod` 仍在目标机器上构建镜像。

## 更新与停止

```bash
# 先完成与当前部署匹配的数据库、附件和配置备份，再更新源码。
make prod
make prod-down
```

`make prod` 构建镜像并等待服务健康；后端自动执行 Core 和全部已安装 App 的前向迁移。`prod-down` 保留数据卷。**不要使用 `down -v` 更新或停止真实部署。**

生产后端以 node 用户运行，镜像预建可写的 storage 目录；新命名卷继承其权限。运行镜像不含 tsx、构建工具或 pg_dump，不能把宿主的 `npm run backup` 命令原样当作容器内命令。数据库备份可使用 database 容器自带的 PostgreSQL 17 工具；附件和配置也必须一起保存。

## 从现有开发或旧 overlay 部署迁移

新的默认生产项目会创建**全新数据库与附件卷**，不会自动采用旧开发数据。保留原容器/卷，安排停写窗口，先备份，再导入新项目。旧 overlay 曾保留开发挂载，以下示例针对数据库卷加宿主 `storage/` 的现有默认布局；自定义布局先核对实际挂载。

```bash
bash <<'BASH'
set -euo pipefail
# 原开发项目：停止写入，数据库保留运行。
docker compose stop frontend backend
umask 077
mkdir -p backups
PP_BACKUP_DIR="$(mktemp -d "$PWD/backups/production-migration.XXXXXX")"
docker compose exec -T database sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' \
  > "$PP_BACKUP_DIR/database.sql"
test -s "$PP_BACKUP_DIR/database.sql"
tar -czf "$PP_BACKUP_DIR/storage.tar.gz" storage
tar -tzf "$PP_BACKUP_DIR/storage.tar.gz" > /dev/null
cp -R config "$PP_BACKUP_DIR/config"

# 确认 .env.production 使用新的项目名，且目标确实是全新数据库。
pp_prod() { docker compose --env-file .env.production -f docker/docker-compose.prod.yml "$@"; }
pp_prod build
pp_prod up -d --wait database
pp_prod exec -T database sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' \
  < "$PP_BACKUP_DIR/database.sql"
pp_prod run --rm -T --no-deps --user root --entrypoint sh backend -c \
  'tar -xzf - -C /workspace && chown -R node:node /workspace/storage' \
  < "$PP_BACKUP_DIR/storage.tar.gz"
pp_prod up -d --wait --wait-timeout 180
BASH
```

导入会替换目标数据库同名对象，只对已确认的全新生产目标执行。先核对备份命令成功和文件完整，再导入；有自定义配置时应先审阅并应用到待构建的 `config/`。SQL 导入失败会使该导入事务回滚，停止后续步骤并排查。已有用户密码不会被 bootstrap 重置；继续使用原管理员登录。

确认健康、原数据、附件下载和登录都正常后，再决定如何保留或清理旧部署及备份。升级既有生产卷时，修改 `POSTGRES_PASSWORD` 环境变量不会自动修改数据库中现有角色的密码；密码轮换需同步数据库角色及部署配置。

## 镜像构建与启动验证

```bash
npm run test:docker:config   # 仅需 Docker CLI/Compose，无需 daemon
npm run verify:docker        # 或 make verify-docker；需 Docker daemon
```

真实验证会用随机项目名、临时凭据、随机回环端口和全新数据卷构建镜像并启动：检查全部 App 迁移、非 root 运行、默认 Secure Cookie、HTTP 显式覆盖、真实登录、SPA/静态资源/API 错误、伪造转发头限速、大于 1 MiB 附件往返，以及全部容器重建后的数据库/附件保留。运行层同时检查开发源码和工具缺失。

成功或失败后只删除该随机验证项目的容器、网络、卷和本地镜像；基础镜像与构建缓存保留。缺失 Docker、构建失败、健康等待失败或断言失败均返回非零，失败附容器日志。GitHub Actions 的 `docker-production` job 从干净 checkout 执行同一入口，不依赖宿主 `dist`、`node_modules` 或已有数据库。
