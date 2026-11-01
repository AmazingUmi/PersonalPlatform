# Settings 数据管理

Settings → Data management 提供 JSON 数据备份、导入预览和合并。普通用户只能导出本人数据，并将本人格式备份导入当前账号；管理员还能选择全站范围。全站文件包含其他用户的数据和账号密码散列，应按敏感资料保存。

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

填写已有 WebDAV 目录 URL、用户名和应用密码，保存后可测试连接、立即备份，或设置每 1/6/12/24/168 小时自动备份。间隔为经过的小时数，不是本地每天固定时间；0 表示关闭自动。服务每分钟检查到期任务，停机后最多补做一次，失败后等下一间隔。配置、下次执行和最近状态保存在数据库中，重启保留。

每个用户拥有独立配置和历史。每次备份重新验证账号状态和权限；禁用账号或降权后不能继续全站备份。手动与定时互斥。文件使用唯一名称并要求不覆盖已有远端文件。成功上传记录列在 Settings（最近 100 条），可下载或预览合并；仅列出本平台记录的上传，不扫描整个网盘。目的地变更后，旧目的地记录不可通过新配置下载；原文件仍可用网盘客户端下载后导入。没有自动删除/保留周期。

密码仅写入、不回显，以 AES-256-GCM 加密存储，不进入通用 settings 或 JSON 备份。默认密钥在持久化 `storage/.core/backup.key`，权限 0600；也可提供 `DATA_BACKUP_ENCRYPTION_KEY`（32 字节标准 base64）。保留原密钥，变更或丢失后需重新输入 WebDAV 密码。备份文件本身未额外加密，使用可信私有目录，尤其不要公开全站文件。

默认只允许公网 HTTPS；证书须有效，重定向不跟随。内网 NAS 或 HTTP 需由部署管理员明确配置精确 origin，例如：

```dotenv
DATA_BACKUP_ALLOWED_ORIGINS=https://nas.example:5006,http://192.168.1.20:5005
```

不要填路径、尾斜线或通配符。修改环境后重启后端。允许 HTTP 意味着凭据和备份在传输中未加密。后端按解析后的 IP 校验并固定连接地址，防止普通用户通过 DNS 重绑定访问内网。WebDAV 使用标准 PROPFIND/PUT/GET；连接测试验证目录响应，实际写权限以备份上传结果为准。[协议参考：RFC 4918](https://www.rfc-editor.org/rfc/rfc4918)。

Docker Compose 已透传上述变量，默认密钥位于持久化 storage 卷。该文件和加密配置是配对的；完整 CLI 备份包含 storage，应同样私密保管。JSON 备份可独立恢复业务数据，无需 WebDAV 密钥。

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
