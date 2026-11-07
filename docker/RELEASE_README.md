# PersonalPlatform 发行镜像部署

这个部署包用于已有 Docker Engine 和 Docker Compose v2.20+ 的 Linux 服务器。支持 `linux/amd64` 与 `linux/arm64`，不需要安装 Node、npm 或下载源码。镜像只包含程序，不包含原电脑上的账号、笔记和附件。

## 首次启动

包含 `deploy.sh` 的新版部署包可在解压目录执行：

```bash
sudo bash deploy.sh
```

脚本用于 Linux，除 Docker/Compose 外还需要 Bash、curl、tar、sha256sum、openssl 和 flock。默认安装到 `/opt/personal-platform`，首次询问管理员用户名和密码（密码隐藏输入），自动生成数据库密码，并选择最新稳定发行版；要指定版本则追加 `--version` 和 `release.json` 中的版本号，例如 `--version v0.1.0`。后续执行 `sudo bash /opt/personal-platform/deploy.sh` 即可检查同版本健康或备份后更新。应用、账号、附件、WebDAV 密钥和私有配置沿用原部署。脚本不安装 Docker，也不配置域名或 HTTPS。

已有 `v0.1.0` 部署包不包含这个后来增加的脚本，也不会被替换。可按[项目部署指南](https://github.com/AmazingUmi/PersonalPlatform/blob/main/doc/DEPLOYMENT.md) 中交付的固定源代码提交地址，先下载完整脚本再执行；无需重发应用镜像。若要接管当前手动发行部署，使用 `bash /path/to/deploy.sh --dir /actual/manual/release/directory --adopt --version v0.1.0`，其中实际目录包含真实 `.env.release` 及本包文件。脚本核验项目和卷身份后保留原数据；源码构建或任意自定义拓扑须先手动核对。

脚本管理的更新在启动新后端前保存数据库、完整存储、旧配置及版本身份。新后端尝试启动后失败时，保留备份和待处理状态并停止写入；先运行保存的脚本加 `--status` 查看，再用 `--resume` 继续记录的同一目标。不适合继续时，需匹配旧版本的完整备份恢复，不能只换旧镜像或删除状态。脚本管理目录中的 `backups/` 和 `.deploy/` 为私有恢复资料，不自动清理。

以下是手动安装方式：

先使用同一 GitHub Release 的外部 `SHA256SUMS` 检查下载的压缩包，再进入对应的解压目录（首版为 `personalplatform-v0.1.0/`）。在解压目录执行：

```bash
sha256sum -c SHA256SUMS
cp .env.release.example .env.release
chmod 600 .env.release
# 编辑 .env.release，填写 POSTGRES_PASSWORD、BOOTSTRAP_ADMIN_USERNAME
# 和 BOOTSTRAP_ADMIN_PASSWORD。密码不使用空值或示例密码。
docker compose --env-file .env.release -f docker/docker-compose.release.yml config --quiet
docker compose --env-file .env.release -f docker/docker-compose.release.yml pull
docker compose --env-file .env.release -f docker/docker-compose.release.yml up -d --no-build --wait --wait-timeout 180
docker compose --env-file .env.release -f docker/docker-compose.release.yml ps
```

包内 `.env.release.example` 使用配套的前后端镜像索引摘要；保留 `BACKEND_IMAGE` 和 `FRONTEND_IMAGE`，不要混用不同版本。`release.json` 记录版本、源代码提交、平台和镜像摘要；包内 `SHA256SUMS` 校验配置和说明文件。已公开的 GHCR 镜像可免登录拉取，Docker 自动选择服务器支持的架构。

私有环境文件中含 `$`、`#` 或空白的值使用单引号。首次启动自动创建/激活首个管理员并执行数据库迁移；已有管理员不会因重启或修改 bootstrap 密码而被重置。修改环境文件的 `POSTGRES_PASSWORD` 也不会自动修改已有数据库角色密码。

## 配置公网访问

默认只向服务器本机提供 `127.0.0.1:5173`；数据库和后端不对公网开放。把域名 HTTPS 反向代理配置为转发到该地址，再通过 HTTPS 登录。生产登录 Cookie 默认带 `Secure`，普通公网 HTTP 不是正式访问入口。证书、域名解析和外层代理由服务器管理员配置。

内层 Nginx 会覆盖客户端提供的转发 IP 头；外层 TLS 代理存在时，默认记录到的可能是代理 IP。需要真实客户端 IP 时，按实际可信代理拓扑修改内层 real-IP 配置并构建自己的镜像，不能直接信任任意请求头。发行镜像中的配置是固定的，改宿主文件不会改动镜像。

## 保存数据与更新

数据保存在命名卷中，默认项目名为 `personal-platform-production`。使用相同项目名和环境配置重建容器会继续使用原数据库和附件卷。镜像更新不会把其他部署的数据自动搬过来。

更新前停止写入并备份相匹配的数据库、整个存储卷、平台配置及版本/镜像摘要；私有环境文件和密钥单独安全保存。存储卷中的 `storage/.core/backup.key` 用于解密保存的 WebDAV 密码，若配置了环境变量密钥则保留原值。Settings JSON/WebDAV 逻辑备份不包含完整的部署状态，不能单独代替灾难恢复备份。

脚本管理的部署使用保存的 `deploy.sh` 更新；不要并行手工修改它的发行目录或状态。手动管理时，下载并校验新版本部署包后，保留真实密码、项目名、端口、WebDAV origin 允许列表和密钥，只将 `.env.release` 的两个镜像引用更新为新包中配套的值，再执行 `pull` 和 `up -d --no-build --wait --wait-timeout 180`。源码构建部署切换到发行包时，也须先核对项目名、实际卷名及自定义配置，避免误用新空卷。

停止并保留数据：

```bash
docker compose --env-file .env.release -f docker/docker-compose.release.yml down
```

不要用删除数据卷的方式停止或更新。数据库迁移只向前执行；换回旧镜像不会撤回迁移。失败时保留备份、旧部署包和摘要，先检查日志；旧程序不兼容新 schema 时，需要停写并恢复相匹配的旧版本数据库、存储和配置。

## 首次验收与同步

检查容器健康、域名 HTTPS、真实登录、常用 App、附件上传下载，以及重启后数据保留，并演练备份恢复。

持续同步需要各部署独立创建本地账号，再用配对码明确关联；它只同步该账号的数据，由保持打开且已登录的平台页面触发。关闭页面或退出登录后，后续同步轮次停止。定时备份是独立的服务器任务。真实 WebDAV 供应商兼容性尚未验收；条件写入探测不通过时拒绝启用持续同步，普通连接测试通过不等于同步可用。

完整部署、资源参数及恢复说明见 [项目部署指南](https://github.com/AmazingUmi/PersonalPlatform/blob/v0.1.0/doc/DEPLOYMENT.md)，备份和同步行为见 [数据管理](https://github.com/AmazingUmi/PersonalPlatform/blob/v0.1.0/doc/DATA_MANAGEMENT.md)。
