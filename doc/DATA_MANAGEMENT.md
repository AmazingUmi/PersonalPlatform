# Settings 数据管理

Settings → Data 提供完整 JSON 数据备份、导入预览和合并；WebDAV 默认增量备份，手动时可选择完整备份。普通用户只能导出本人数据，并将本人格式备份导入当前账号；管理员还能选择全站范围。全站文件包含其他用户的数据和账号密码散列，应按敏感资料保存。

Settings 分为 General、Data、WebDAV 和仅管理员可见的 Users。分区链接支持刷新和浏览器前进/后退；在同一 Settings 页面内切换时保留未保存输入及导入预览，离开页面或刷新不会保存这些草稿。Data 中使用 Choose file 按钮选择本地完整 JSON 文件。

## 导出与合并

- 导出包含当前支持的 Tasks、Notes、Assets、Clock、Focus、2048 数据，含禁用 App 的数据与 Assets 附件。支持表/列明确列举；发现未适配的 App 数据会拒绝导出，避免无提示遗漏。
- JSON 文件上限为 **32 MiB**（附件为 base64 后计入），最多 100,000 行；超限使用原有 CLI 备份。文件格式独立于 App Contract V1。
- 上传文件后先预览，再点击合并。合并保留当前记录，补入缺失记录；已有记录计入 skipped，不覆盖较新的编辑。分类/标签同名时复用目标并重映射关系。重复导入不重复创建记录或附件。
- 本人备份只含单个源账号数据，导入时归属绑定当前登录用户。UUID 已属于其他用户则整批拒绝，不能借文件修改其他账号。
- 全站合并仅接受精确匹配的账号 ID 与用户名；同名不同 ID 或同 ID 不同用户名都拒绝，避免错误关联身份。已有账号密码、角色和状态保持不变；新增账号按备份创建。不同部署之间的个人资料迁移宜使用本人备份。
- 外键/用户归属、schema、附件摘要、重复主键、日期等会校验。与当前 Focus 计时器冲突的历史 active session 会拒绝；先结束冲突计时器再试。
- schema 指纹校验列名、类型和可空性，不等同于迁移历史或业务语义的完整版本证明；约束由目标数据库在预览/合并时再次执行。今后只改变语义而不改列的迁移，必须同时审查备份适配器及格式兼容性，不能仅凭指纹相同宣称兼容。
- 数据库写入使用单事务及表锁，失败回滚。附件写到新的随机路径，从不覆盖原文件；常规失败清理本次文件。进程中断可能留下未引用文件，因此不宣称数据库和文件系统整体原子恢复。
- 若连接在提交确认时中断，会保留新附件并报告“提交结果待确认”；重新加载数据后可重试同一备份。不能将这种结果当作确定回滚而删除文件。

这个 JSON 是**可合并的逻辑数据备份**。它不包含登录会话、App 启停状态、迁移执行历史、后台清理任务、WebDAV 配置/密钥、环境变量或平台配置文件。全站包只包含允许恢复的呈现设置，时区等运行设置保留当前值。完整停机灾难恢复仍使用 `npm run backup` / `npm run restore`。

## WebDAV

WebDAV 分为 Connection（连接与定时配置）、Backup（立即备份及状态）、History（历史记录）。在 Connection 填写已有 WebDAV 目录 URL、用户名和应用密码，填写后即可点击 **Test connection** 测试当前输入，无需先保存；测试成功不保存配置，也不启用定时备份。在 **Save backup settings** 保存后，可在 Backup 立即备份，或设置每 1/6/12/24/168 小时自动备份。间隔为经过的小时数，不是本地每天固定时间；0 表示关闭自动。服务每分钟检查到期任务，停机后最多补做一次，失败后等下一间隔。配置、下次执行和最近状态保存在数据库中，重启保留。

连接测试只验证 WebDAV 连接和目录访问，不验证备份写入权限。编辑地址、用户名或密码后，旧测试结果失效。已有连接不改地址和用户名时可留空密码复用保存值；新连接或更换目标/账号必须重新输入密码，测试失败保留草稿。

坚果云地址为 `https://dav.jianguoyun.com/dav/`（或其下已存在目录），用户名为账号邮箱，密码使用第三方应用密码。[坚果云官方配置说明](https://help.jianguoyun.com/?p=3234)。

| 操作 | 格式与行为 |
|---|---|
| 本地 Export backup / 文件导入 | 独立完整 v1 JSON，沿用原有预览/合并规则 |
| WebDAV 定时备份 | 固定使用增量方式 |
| WebDAV 手动 Incremental | 默认；首次建立基线，之后只上传变化的数据块、新附件和引用清单 |
| WebDAV 手动 Full | 每次上传独立完整 v1 JSON；不改变定时增量设置，也不清空增量对象库 |

增量按主键稳定划分的记录块与附件内容去重，不是逐次上传整个 JSON。新增、修改和删除都会反映在新备份点的完整引用清单中；内容相同的附件在同一用户/范围/目的地/远端账号内只存一份。数据没有变化且远端对象完整时不上传文件、不新增历史；缺失对象可从当前数据补传，界面会显示实际修复量。备份仍需读取完整逻辑快照来识别变化，**增量指网络上传和远端存储，不代表增量 SQL 扫描**。每次最多引用 1024 个对象，重组后的 JSON 仍受 32 MiB / 100,000 行限制。

每个用户拥有独立配置和历史。每次备份重新验证账号状态和权限；禁用账号或降权后不能继续全站备份。手动与定时互斥。远端对象与清单不可覆盖；所有引用对象就绪后才发布清单并记录成功。失败可能留下未引用对象，重试会校验后复用，不自动删除。History 展示最近最多 100 条，每页 10 条，区分 Full/Incremental、完整数据大小与实际上传量；仅列出本平台记录，不扫描整个网盘。新备份同时绑定目的地 URL 和远端用户名，修改任一项后旧记录不可借新配置下载。已有旧版全量备份继续按原目的地规则下载。

在 WebDAV → History 点击增量历史的 Download 或 Review，服务器会校验清单、读取并逐个校验引用对象，返回完整 v1 JSON；Review 自动切到 Data 展示预览，用户确认后才合并。如果读取或预览失败，错误在 Data 显示，并保留此前的本地导入草稿。每个清单是独立恢复点，不依赖之前的清单，但必须保留它引用的对象。历史中的删除表示该备份点已不包含相应记录；**导入合并依然保留当前记录，不会删除当前数据库中的内容**。

增量备份复用对象时用 HEAD 验证存在和长度，缺失则补传，异常长度则拒绝覆盖。上一清单本身须通过摘要和结构检查，丢失或损坏时明确失败；可先手动创建独立完整备份，再恢复缺失的清单/对象。HEAD 不能发现同长度内容篡改，此类损坏在下载/恢复的 SHA-256 校验中检出。新遇到但远端已存在的同名对象也必须下载验 hash 后复用。全部远端操作共用 180 秒预算，超限明确失败，不静默改成全量。

密码仅写入、不回显，以 AES-256-GCM 加密存储，不进入通用 settings 或 JSON 备份。默认密钥在持久化 `storage/.core/backup.key`，权限 0600；也可提供 `DATA_BACKUP_ENCRYPTION_KEY`（32 字节标准 base64）。保留原密钥，变更或丢失后需重新输入 WebDAV 密码。备份文件本身未额外加密，使用可信私有目录，尤其不要公开全站文件。

默认只允许公网 HTTPS；证书须有效，重定向不跟随。内网 NAS 或 HTTP 需由部署管理员明确配置精确 origin，例如：

```dotenv
DATA_BACKUP_ALLOWED_ORIGINS=https://nas.example:5006,http://192.168.1.20:5005
```

不要填路径、尾斜线或通配符。修改环境后重启后端。允许 HTTP 意味着凭据和备份在传输中未加密。后端按解析后的 IP 校验并固定连接地址，防止普通用户通过 DNS 重绑定访问内网。WebDAV 使用 PROPFIND/PUT/GET/HEAD；连接测试验证目录响应，实际写权限以备份上传结果为准。[协议参考：RFC 4918](https://www.rfc-editor.org/rfc/rfc4918)。

### DNS / Fake-IP 导致公网网盘被拦截

如果出现 `webdav_origin_blocked`，请求在认证前被拦截，不能由此判断账号密码错误。代理的 Fake-IP 模式可能把公网域名解析到 `198.18.0.0/15` 等保留网段；应在**后端所在容器或服务器**检查解析，宿主和容器的结果可能不同。

优先调整代理/DNS，使该网盘域名获得真实公网解析；如果部署明确依赖可信的 Fake-IP 路由，可在部署环境中追加对应的精确 origin，例如：

```dotenv
DATA_BACKUP_ALLOWED_ORIGINS=https://dav.jianguoyun.com
```

已有项目用逗号追加并保留原值。这里不含 `/dav/` 路径，不能填写 `*` 或放行整个保留网段。生产 Docker 修改 `.env.production` 后必须重建后端容器才能载入环境变量（单纯 `docker restart` 不会载入新环境）；例如 `docker compose --env-file .env.production -f docker/docker-compose.prod.yml up -d --no-deps --wait backend`。此设置仅允许指定 origin，TLS 证书验证和禁止重定向仍然启用。不要把凭据写入 origin，也不要提交环境文件。

Docker Compose 已透传上述变量，默认密钥位于持久化 storage 卷。该文件和加密配置是配对的；完整 CLI 备份包含 storage，应同样私密保管。JSON 备份可独立恢复业务数据，无需 WebDAV 密钥。

### 本地历史数据库丢失时恢复增量备份

使用网盘客户端下载所需的增量清单以及它引用的全部对象，保留原文件名。不能只下载一个清单后直接导入 Settings；也不要删除看似“重复”的对象，它们可能被多个历史备份引用。完整备份 JSON 可直接导入，无需本步骤。

```bash
npx tsx scripts/reconstruct-backup.ts \
  --manifest /path/to/downloaded-manifest.json \
  --objects /path/to/downloaded-objects \
  --output /tmp/recovered-full-backup.json
```

该工具不连接数据库、不依赖 `backup_history` 或 WebDAV 凭据；它仅从指定普通文件重组完整 JSON，并验证命名、大小、引用及 SHA-256。路径穿越、符号链接、缺失对象或错误摘要都会拒绝；输出采用 0600 权限且不覆盖已有文件。生成后在 Settings 选择输出文件，预览并合并。当前不提供远端历史自动发现或远端垃圾回收。

## 旧 CLI 备份转为可合并文件

Settings 不执行 SQL 或解包任意上传。旧 `metadata.json + database.sql + storage.tar.gz + config/` 目录须先恢复到**独立临时项目与空数据库**，再前向迁移并导出 JSON。只处理可信来源 SQL，不将不可信文件交给数据库执行。

以下命令中的路径、连接串和用户名均需替换为独立恢复目标。临时数据库不能是生产库，也不要运行临时后端/调度器；保持恢复过程离线。

```bash
# 先建立独立项目副本和独立空数据库；不要复用生产 storage。
git clone /path/to/PersonalPlatform /tmp/pp-legacy-convert
cd /tmp/pp-legacy-convert
npm ci
createdb -h 127.0.0.1 -U operator pp_legacy_convert

# 受信任的旧备份恢复到这个独立副本（恢复会覆盖目标）。
npm run restore -- /path/to/trusted-backup --yes \
  --database postgresql://operator@127.0.0.1/pp_legacy_convert \
  --root /tmp/pp-legacy-convert
DATABASE_URL=postgresql://operator@127.0.0.1/pp_legacy_convert npm run migration:up

# --user 指数据库中的现有账号用户名；导出全站需该账号为 active admin。
npx tsx scripts/export-data.ts \
  --database postgresql://operator@127.0.0.1/pp_legacy_convert \
  --storage /tmp/pp-legacy-convert/storage \
  --user admin --scope all --output /tmp/legacy-data.json
```

将 JSON 在正式 Settings 中预览、合并。目标已有同名不同 ID 管理员会触发身份冲突，可改为 `--scope own` 导出该账号资料并导入当前账号。迁移不支持的更早历史 schema 会明确失败；不保证任意外部数据库可转换。若备份早于多用户迁移，应先按迁移运行手册完成旧附件目录迁移，再导出，不手工改 owner ID。

真实网盘供应商兼容性需用部署环境中的实际地址和凭据验证；自动化测试使用本地真实 HTTP WebDAV 模拟服务，不代替供应商验收。
