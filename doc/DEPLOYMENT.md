# Docker 开发与生产部署

开发与生产使用独立的 Compose 文件。每个入口文件**单独运行**，不要与根目录开发文件合并。生产的源码构建和发行镜像入口共用 `docker/docker-compose.runtime.yml`；该文件只提供运行配置，不单独启动。

| 场景 | 入口 | 运行方式与数据 |
|---|---|---|
| 开发 | `make dev` | `docker-compose.yml`；源码 bind mount、tsx/Vite 热更新；附件在宿主 `storage/` |
| 开发调试端口 | `make dev-expose` | 额外发布数据库与后端回环端口，前端可供 LAN 访问 |
| 生产：脚本管理 | `bash deploy.sh` | 首次安装，后续自动备份并更新相同项目和数据卷 |
| 生产：发行镜像 | 见下文 | `docker/docker-compose.release.yml`；拉取配套镜像，无需源码、Node 或本机构建 |
| 生产：源码构建 | `make prod` | `docker/docker-compose.prod.yml`；在目标机器构建编译后 Node + Nginx |
| 本地开发 | 见 [DEVELOPMENT.md](DEVELOPMENT.md#本地无-docker-跑法) | Node 与 PostgreSQL 直接运行，Docker 可选 |

## 一条命令安装和更新

适用于 Linux 服务器。先安装 Docker Engine、Docker Compose v2.20+、Bash、curl、tar、sha256sum、openssl 和 flock，并确保当前用户可访问目标 Docker daemon（示例用 `sudo`）。服务器不需要 Node、npm、Python、jq、源码或编译工具。脚本不安装 Docker，不配置域名、证书或 HTTPS 反向代理。

在自己的工作目录执行下列一行。将 `<SCRIPT_COMMIT>` 替换成交付记录中经过验证的完整脚本提交 SHA；不要填应用镜像的 `v0.1.0` 标签，因为该发行版早于部署脚本。下载成功后才会执行本地文件，可先阅读文件再运行：

```bash
curl -fL --proto '=https' --tlsv1.2 'https://raw.githubusercontent.com/AmazingUmi/PersonalPlatform/<SCRIPT_COMMIT>/scripts/deploy.sh' -o personal-platform-deploy.sh && sudo bash personal-platform-deploy.sh
```

默认部署目录是 `/opt/personal-platform`。首次运行询问管理员用户名，并要求输入两次密码，密码输入不显示；数据库密码自动生成。用户名为 3–32 个小写字母、数字、下划线或连字符，管理员密码为 8–256 个字符。凭据保存在私有 `.env.release`，重跑和更新不重新生成密码。脚本先解析一次 GitHub 最新稳定发行版，再固定这一版的配套镜像；也可以明确指定 `--version v0.1.0`。

成功后，脚本将自身保存为 `/opt/personal-platform/deploy.sh`，并注册 `/usr/local/bin/pp`。在任意目录更新执行：

```bash
pp update
```

| 命令 | 用途 |
|---|---|
| `pp update` | 更新到最新稳定发行版 |
| `pp update --version v0.1.0` | 选择明确的稳定版本，不接受降级 |
| `pp status` | 查看当前版本和未完成操作 |
| `pp resume` | 排除故障后继续记录的同一目标版本 |
| `pp help` | 查看用法，无须访问私有部署资料或 sudo |

命令绑定原部署目录，root 管理的部署在普通用户调用时按系统 sudo 规则请求验证；以其他普通用户管理的部署，须由原管理用户执行。命令不修改 sudoers。服务器 PATH 需包含命令目录，默认可直接使用 `/usr/local/bin/pp`。原来的完整路径命令 `sudo bash /opt/personal-platform/deploy.sh` 仍可使用。

脚本下载并校验部署包、拉取两个配套镜像后，才会停止前后端写入和调度，备份数据库、整个存储卷（含 WebDAV 密钥）、原私有配置、旧版本元数据和实际镜像/卷身份，再启动新应用。常规更新沿用原数据库容器，不升级 PostgreSQL。健康和就绪检查通过后才记录新版本为当前版本；同版本重复运行检查健康并登记命令入口，不重置账号或重建数据。

已用旧脚本部署的服务器，先按上面的固定提交地址重新下载新版脚本，再执行 `sudo bash personal-platform-deploy.sh --dir /opt/personal-platform` 补装 `pp`；非默认安装须填写原来的真实目录。单纯运行旧版保存的脚本不能获得后来新增的命令功能。新脚本遇到已有的无关 `pp`、其他部署的入口或被手动修改过的入口会明确拒绝覆盖，并在停写前退出。

安装目录中保留 `.env.release`、`releases/`、私有 `backups/` 和 `.deploy/` 状态。不要手工覆盖这些状态文件或删除恢复资料。备份默认不自动清理，请按服务器磁盘容量另行安排留存和异地副本。此处管理的是服务器上这一套已有数据卷，不会自动导入电脑上的开发数据库。

常用参数：

| 参数 | 用途 |
|---|---|
| `--dir /path/to/deployment` | 指定稳定部署目录；之后每次操作都使用同一路径 |
| `--command-dir /path/to/bin` | 首次选择 `pp` 命令目录，默认 `/usr/local/bin`；后续沿用保存的目录，一个命令目录绑定一套部署 |
| `--version v0.1.0` | 安装或更新到明确的稳定版本；不接受降级或预发行版本 |
| `--env-file /private/initial.env` | 首次安装读取已准备的私有生产配置，适合非交互执行；更新不接受用它替换现有凭据 |
| `--bundle-dir /path/to/assets --version v0.1.0` | 使用提前下载的 `personalplatform-v0.1.0.tar.gz` 和外部 `SHA256SUMS`；仍会做相同校验并从镜像仓库拉取镜像，需要访问镜像仓库 |
| `--adopt` | 明确接管 `--dir` 指向的已有手动发行部署，见下文 |
| `--status` | 只查看已接受版本和待处理操作 |
| `--resume` | 显式继续上次未完成操作，使用其已记录的目标版本和备份 |

`--env-file` 相对路径以运行命令时的工作目录为准，建议使用绝对路径。首次非交互配置应按发行环境模板准备，填写非空的 `POSTGRES_PASSWORD`、`BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD`，保留所需端口、项目名、资源、WebDAV origin 和密钥设置；将文件设为 0600，通过文件传递密码，不把密码写在命令行参数里。镜像引用取自经过校验的同版部署包。非默认目录的例子：

```bash
sudo bash personal-platform-deploy.sh --dir /srv/personal-platform --version v0.1.0 --env-file /private/personal-platform.env
```

非 root 部署可显式选用自己拥有的命令目录，例如追加 `--command-dir "$HOME/.local/bin"`，并确保该目录已在自己的 PATH 中。目录、锁和入口须由执行部署的用户拥有，且不能允许其他用户写入；部署和命令目录的父路径也须由该用户或 root 控制，避免整个目录被其他用户替换。root 管理的部署宜使用 `/opt`、`/srv` 等受 root 控制的路径。脚本不会编辑 shell 配置。`pp` 固定使用登记的目录，拒绝 `--dir`、`--command-dir`、`--env-file` 或 `--adopt` 等身份修改参数。若健康验收后登记命令遇到文件系统错误，已接受的服务保持运行；按错误中给出的本次新脚本路径与原 `--dir` 重跑即可重试登记。

### 接管已有手动发行部署

`--dir` 必须指向当前实际使用的、正在运行的发行部署目录，其中应有真实 `.env.release` 及 `docker/docker-compose.release.yml`、`docker/docker-compose.runtime.yml` 和版本元数据。先另存一份完整备份，再明确接管；例如原目录为 `/srv/personalplatform-v0.1.0`：

```bash
sudo bash personal-platform-deploy.sh --dir /srv/personalplatform-v0.1.0 --adopt --version v0.1.0
```

脚本会核对项目标签与数据库、存储的实际挂载身份；同版本接管不切换应用，并将 `pp` 绑定到这个真实目录，之后执行 `pp update`。首次部署遇到已有同名项目或卷会拒绝，不能用修改项目名的方式绕过并把空数据库当作旧数据。源码构建、任意自定义卷或其他非标准拓扑可能被拒绝，应先按本指南手动核对迁移，不能强行自动接管。

### 更新失败和恢复

```bash
pp status
# 排除网络、镜像或运行环境问题后，继续已记录的同一目标：
pp resume
```

下载或拉取失败发生在停写之前，原应用继续运行。备份失败且新后端尚未尝试启动时，脚本只恢复本次停止的旧服务。新后端一旦尝试启动，数据库可能已迁移；此后失败或中断会保留待处理状态、备份和数据，并停止应用写入。普通重跑不能越过此状态，也不能换一个版本替代未完成操作；`--resume` 是向同一目标继续重试。

`--resume` 不会恢复旧数据库或撤回迁移。若目标无法继续，保持停写并根据输出的备份路径检查完整标记和备份资料，按相匹配的旧数据库、存储、私有环境、平台配置和旧版本恢复。不要只改回旧镜像或删除 `.deploy/pending` 来绕过状态，详见 [迁移与恢复运行手册](MIGRATION_RUNBOOK.md)。脚本的隔离容器验证不代表已经完成真实公网服务器或真实 WebDAV 供应商验收。

## 手动首次使用发行镜像

服务器需要 Docker Engine 与 Docker Compose v2.20+。在 [Releases](https://github.com/AmazingUmi/PersonalPlatform/releases) 选择已完成发布的版本，下载 `personalplatform-v0.1.0.tar.gz` 和该 Release 的 `SHA256SUMS`。已有 `v0.1.0` 可由独立部署脚本消费；它的应用镜像和部署包不因新增脚本而重发。下列为手动流程：

以 Linux 服务器为例，在下载文件所在目录执行：

```bash
sha256sum -c SHA256SUMS
tar -xzf personalplatform-v0.1.0.tar.gz
cd personalplatform-v0.1.0
sha256sum -c SHA256SUMS
cp .env.release.example .env.release
chmod 600 .env.release
# 编辑 .env.release，填写数据库和首个管理员的密码。
docker compose --env-file .env.release -f docker/docker-compose.release.yml config --quiet
docker compose --env-file .env.release -f docker/docker-compose.release.yml pull
docker compose --env-file .env.release -f docker/docker-compose.release.yml up -d --no-build --wait --wait-timeout 180
docker compose --env-file .env.release -f docker/docker-compose.release.yml ps
```

外部校验文件检查部署包，包内校验文件检查解压后的配置和说明。不要把不同版本的 Compose 文件混在一起，也不要修改镜像摘要来绕过校验。包内 `release.json` 记录源代码提交、版本、支持架构及两个镜像的索引摘要；`.env.release.example` 已填入同一版配套镜像的 `BACKEND_IMAGE` / `FRONTEND_IMAGE` 摘要引用。公开 GHCR 包无需 `docker login` 即可拉取。源码仓库的示例使用明确版本标签，发行包则固定到索引摘要；镜像标签不使用 `latest`，已发布版本不覆盖。

启动完成后，先在服务器检查容器健康，再通过已配置的域名 HTTPS 登录并检查常用 App、附件上传下载及重启后的数据。部署默认只绑定 `127.0.0.1:5173`，不会直接开放公网 HTTP；HTTPS 反向代理及客户端 IP 处理见下文。新安装是空数据库，镜像不带开发机器上的用户数据。

发行镜像内包含固定版本的 `config/`。需要修改构建时平台配置或内层 Nginx 可信代理规则时，使用下面的源码构建入口生成自己的镜像；修改宿主仓库文件不会改变已经拉取的发行镜像。

## 首次从源码构建生产环境

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

自定义项目名、端口和凭据写在对应的私有环境文件：源码构建为 `.env.production`，发行镜像为 `.env.release`。源码构建可用 `make PROD_ENV=/path/to/private.env prod` 指定其他文件。自定义 `config/` 在构建前修改并审阅，生产默认不挂载宿主源码或配置。构建上下文排除环境密钥、备份和测试认证文件。

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

三个生产服务均使用 `json-file` 日志轮转，每个文件最多 `10m`、保留 3 个文件。后端仍默认 `INFO`；希望减少请求日志写入时可以显式设置 `LOG_LEVEL=warn`，错误日志仍保留。开发配置保持原有热更新行为。`make prod` 继续在目标机器构建；需要避免目标机器构建开销时，使用已完成发布的多架构镜像和发行部署包。

## 更新与停止

脚本管理的部署使用上文一条命令更新；不要同时手工更新其 `releases/` 或状态文件。手动管理发行镜像时，先停止写入并完成与当前版本匹配的备份，再下载、校验并解压新版本部署包。保留原私有 `.env.release` 中的密码、项目名、端口、WebDAV origin 允许列表和密钥设置，只把 `BACKEND_IMAGE` / `FRONTEND_IMAGE` 更新为新包中配套的引用；不要用空白模板覆盖真实凭据。审阅新版本说明后执行：

```bash
docker compose --env-file .env.release -f docker/docker-compose.release.yml pull
docker compose --env-file .env.release -f docker/docker-compose.release.yml up -d --no-build --wait --wait-timeout 180
docker compose --env-file .env.release -f docker/docker-compose.release.yml ps
# 停止并保留数据卷：
docker compose --env-file .env.release -f docker/docker-compose.release.yml down
```

源码构建更新和停止仍使用：

```bash
# 先完成与当前部署匹配的数据库、附件和配置备份，再更新源码。
make prod
make prod-down
```

`make prod` 构建镜像并等待服务健康；后端自动执行 Core 和全部已安装 App 的前向迁移。`prod-down` 保留数据卷。**不要使用 `down -v` 更新或停止真实部署。**

两个生产入口使用相同的 `COMPOSE_PROJECT_NAME` 默认值 `personal-platform-production`、`postgres-data` 与 `app-storage` 卷名。既有源码构建部署切换到发行镜像时，先备份并核对实际项目名、卷名和私有凭据，再使用相同项目和相同数据库、附件卷启动；不能改项目名后把新空卷当作原数据。自定义的构建时配置还须确认发行镜像是否适用。

生产后端以 node 用户运行，镜像预建可写的 storage 目录；新命名卷继承其权限。运行镜像不含 tsx、构建工具或 pg_dump，不能把宿主的 `npm run backup` 命令原样当作容器内命令。数据库备份可使用 database 容器自带的 PostgreSQL 17 工具。完整灾难恢复需要同一停写窗口下相匹配的数据库、整个附件/存储卷、平台配置、版本/镜像摘要记录及另行安全保存的私有环境文件；存储卷含 WebDAV 加密密钥 `storage/.core/backup.key`，若使用环境变量密钥也必须保留原值。Settings JSON/WebDAV 逻辑备份不包含这些全部运行资料，不能代替整套部署备份。

若更新失败，保留原备份、旧部署包和镜像摘要，先检查容器日志及迁移结果。迁移是前向执行；切回旧镜像不会撤回数据库变更。只有确认旧版本兼容当前 schema 时才可只换镜像；否则保持停写，按相匹配的旧版本数据库、存储和配置备份恢复，参见 [迁移与恢复运行手册](MIGRATION_RUNBOOK.md)。

## 备份与持续同步的部署边界

WebDAV 密码在本地加密保存，部署间搬迁需保留上述密钥或重新输入 WebDAV 密码。内网 NAS、HTTP 或特殊 DNS/Fake-IP 路由的精确 origin 允许列表按 [数据管理](DATA_MANAGEMENT.md) 配置，不随镜像公开。

持续同步须在每台部署分别创建本地账号，再用配对码明确关联云端同步身份；它只处理当前账号的应用数据。同步由已登录且保持打开的平台页面触发，关闭页面或退出后没有服务器后台同步任务替用户继续运行。定时备份是独立的服务器任务。真实坚果云等供应商的创建、加入和条件写入尚未验收；同步的条件写入探测不通过时拒绝启用，不能把普通连接测试通过当成持续同步已兼容。完整使用和边界见 [数据管理](DATA_MANAGEMENT.md)。

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
# 验证已有镜像，不重新构建（使用精确摘要时可校验对应发行候选）：
node scripts/verify-docker.mjs --backend-image BACKEND_REFERENCE --frontend-image FRONTEND_REFERENCE --pull
```

真实验证会用随机项目名、临时凭据、随机回环端口和全新数据卷构建镜像并启动：检查全部 App 迁移、非 root 运行、默认 Secure Cookie、HTTP 显式覆盖、真实登录、SPA/静态资源/API 错误、伪造转发头限速、大于 1 MiB 附件往返，以及全部容器重建后的数据库/附件保留。运行层同时检查开发源码和工具缺失。

成功或失败后只删除该随机验证项目的容器、网络和卷；源码构建模式同时清理该项目构建的本地镜像，已有镜像模式保留传入镜像。基础镜像、构建缓存及其他项目不受影响。缺失 Docker/镜像、构建失败、健康等待失败或断言失败均返回非零，失败附容器日志。GitHub Actions 的 `docker-production` job 从干净 checkout 执行源码构建入口，不依赖宿主 `dist`、`node_modules` 或已有数据库；发行流程另在原生 amd64/arm64 runner 验证精确候选摘要后才发布版本索引和部署包。
