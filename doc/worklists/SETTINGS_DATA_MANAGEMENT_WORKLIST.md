# Settings 数据管理与 WebDAV 备份

## 目标、缺口与授权边界

Settings 增加数据库导出、历史备份合并导入，以及 WebDAV 手动和自动备份。用户明确要求：管理员可选择全站或本人数据，普通用户仅本人；手动与定时备份均需实现。

现有 `scripts/backup.ts` 是停机使用的可信 SQL + storage + config 目录备份/覆盖恢复；Settings 无数据管理入口。现有多用户所有权、关系表、附件及服务器会话不能以通用 SQL HTTP 执行器处理。

架构判断：本任务明确是平台级数据管理，批准新增限定的 `backend/src/core/data-management/` 服务、Core 路由接线及一条前向 Core 迁移；不得改变 App Contract V1、platformApiVersion、App 生命周期或各 App 读写权限。不是以普通 App 跨 schema 偷读数据。备份数据适配器显式枚举受支持表，新增 App 时不得静默遗漏其数据。

## 冻结设计

### 1. 两种导出范围和版本化数据包

- 新 Settings 格式：有独立 magic/type 与 `formatVersion: 1` 的 JSON 数据包，含创建时刻、scope (`own` / `all`)、源身份映射信息、App/迁移兼容性信息、数据表、附件内容和 SHA-256。HTTP/客户端/远端下载均有同一明确字节上限，超限必须失败，不生成声称完整的截断包。
- `own`：仅当前身份拥有的 App 行；`notes.note_tags` / `assets.item_categories` 经所属父表过滤，附件经当前用户 Storage 读取。身份字段只用于来源说明，绝不包含密码散列、会话或其他用户。普通用户请求 all 明确 403；管理员可以二选一。
- `all`：全部用户及受支持 App 数据，包含恢复账户所需密码散列（导出 UI 明示敏感），以及可恢复的平台呈现设置。此为可合并的逻辑数据备份；不声称 PostgreSQL 物理镜像。会话/token、迁移执行历史、运行时 App registry 状态、清理队列、WebDAV 密钥/配置和 `.env` 不导入；SQL 全量灾难恢复仍由原 CLI 承担。
- 受支持表：tasks.tasks；notes.notes/tags/note_tags；assets.categories/items/item_categories/attachments；clock.settings/alarms/world_clocks；focus.settings/sessions；mini_game.saves。只导出实际存在的受支持 schema，disabled App 数据仍包含。发现受支持 schema 内未识别业务表或未适配的 installed App 数据时，明确拒绝并指出缺失适配，不能无提示丢弃。
- 导出采用同一只读 repeatable-read 事务获得一致数据库快照；附件是不可变内容，读取缺失/错误或摘要不符必须失败。数据库和文件系统没有联合快照；并发删除导致失败应重试，不允许缺附件成功。保持 DATE 原始 YYYY-MM-DD，不用系统本地日期重编码。

### 2. 合并规则（不实现覆盖删除）

- 上传后先展示来源、范围、表/文件数量及“保留当前记录、只补入缺失数据”规则，再由用户执行合并。服务端重新完整验证，不信任客户端预览或上一次验证。
- 仅允许数据对象；表名/列名用编译时 allowlist，值参数化。拒绝未知版本/字段、重复主键、非法类型、缺失关系、跨用户关系、错误摘要、路径穿越、过大包和不支持的 schema 版本。数据库约束是后盾，不替代跨用户关系校验。
- `own` 导入仅接受 own 包，将所有源拥有者映射至当前用户；请求中的 user_id 不决定目标身份。all 包只能管理员按 all 范围导入，普通用户不能借其读取/合并其他用户。
- all 用户仅在 id 与 username 均一致时匹配，保留其角色、状态、密码及登录信息；新用户在 id/username 均无冲突时按包创建。id 或 username 单方冲突整次拒绝，绝不按同名自动合并不同账户。至少当前管理员及现有会话保持不变。
- 主键已存在时保留当前行并计数；同一 UUID 属于另一用户时整次拒绝，防止错连/泄漏。categories/tags 按映射后的 `(user_id, name)` 复用目标，并重映射关联。关系表取并集；用户设置/游戏槽按 `(user_id,id)` 保留当前。不得用笼统 `ON CONFLICT DO NOTHING` 掩盖其他唯一约束或错误关系。
- Focus 新导入的 running/paused 行如与目标已有 active session 冲突，整次拒绝并解释；不静默取消会话或覆盖当前计时器。
- DB 全部写入在单事务内，使用稳定顺序的必要表锁/序列化策略防止并发合并及常规 App 写入绕过预检；超时返回可重试冲突。DB 回滚不留半批记录。
- 附件先验证并写入新的随机、用户所属 storage key，任何现有文件都不覆盖；只有实际插入的 metadata 引用这些新 key。失败清理本次新文件；清理失败保留可追踪信息，不删除原文件。成功提交后，重复导入不新增重复数据/文件。中断可能留下不被引用的新文件，不能声称数据库/文件系统整体事务。
- 返回 inserted / preserved 等计数及明确冲突错误；任何跳过必须有计数且 UI 可见。

### 3. 旧备份兼容路径

- 在线仅接受上述 Settings JSON；不直接执行 `.sql`、tar 或任意数据库上传。
- 对现有 CLI `formatVersion:1` 目录提供文档化、可复现的离线转换路径：在独立临时项目目录及独立 PostgreSQL 数据库，用原可信 CLI restore 恢复，运行当前前向迁移，再用新增导出 CLI 生成同一 Settings JSON，最后在线合并。转换 CLI 只连接显式数据库/存储路径并重用同一 exporter，不能默认指向生产库。
- 旧 SQL 本质可执行，仅限用户可信历史备份；此流程在隔离目标执行。README 必须给出完整命令和支持边界；不声称任意历史 schema 自动兼容。至少覆盖当前旧 CLI 格式往返转换集成测试。

### 4. WebDAV 配置、手动与自动备份

- 每个用户有独立配置：目录 URL、用户名、写入式密码、默认 scope、自动开关、间隔（例如 1/6/12/24 小时）、next_run_at、最近结果。管理员可设 all，普通用户只能 own。配置读取返回 passwordConfigured，永不回传密码。
- 新 Core 表 `core.backup_targets` 按 user_id FK 归属，密码用 AES-256-GCM 加密；密钥优先取可选 `DATA_BACKUP_ENCRYPTION_KEY` 环境变量（32-byte base64），否则保存在 storage/.core（目录 0700）的权限 0600 文件，拒绝 symlink，通过 exclusive create 保证并发一致，不进入逻辑备份。密钥丢失/错误时本地导入导出仍可用，WebDAV 执行明确不可用且不启动失败循环。密钥不入 DB、通用 settings、导出包、日志或浏览器持久存储。密码字段省略=保留；endpoint/username 改变必须重新提供密码；删除配置使用明确 DELETE。Settings 现有“secrets always environment”提示同步改为准确说明。
- HTTPS 默认；测试/内网 NAS 若需 HTTP 必须通过明确服务器 exact-origin allowlist 允许，并在配置 UI 说明传输未加密。拒绝 URL userinfo/query/fragment，拒绝重定向转发凭据；所有网络请求有超时、响应体大小上限，错误信息不含凭据/服务器响应原文。
- 目录由用户提供的 WebDAV collection 指定；实现连接测试、PUT 新文件、列出本系统记录的当前用户成功上传备份、GET 下载历史备份，再走同一预览/合并流程。名称由服务端生成（UUID 和固定安全前缀），禁止客户端路径穿越或任意 URL。PUT 使用防覆盖语义；不实现远端自动删除/保留策略。
- 网络目的地默认解析并限制公网地址，内部 NAS 需操作者环境变量显式允许精确 origin（scheme/host/port）；解析结果需绑定实际请求连接，阻止 DNS rebinding。仅认证用户自己的配置可触发，凭据只发往该配置的 origin/path。历史列表来源于 Core 上传历史表，GET 仅接受本用户成功记录 ID 并匹配该配置 endpoint，不能用外链/父目录或任意文件名。
- 自动备份用既有 Core Scheduler，新增一个 owner 清晰的 core 轮询 job，使用持久 next_run_at 和每用户互斥/数据库 advisory lock；手动与定时不能重叠。执行前重新查用户 active 状态和 all 权限，账号降权/禁用后不能沿用旧权限。配置与下次执行持久化，重启恢复；失败记录安全摘要并推迟至下个间隔，无紧密重试。停机错过的计划恢复后最多补一次，不追赶全部历史时段。
- 间隔以 UTC 时间戳衡量，不冒充用户本地“每天固定时刻”，UI 明确“每 N 小时”。无需改变 TimeService 日历语义。关闭配置停止后续任务；平台停止时停止新增任务并处理正在执行请求的退出边界。

### 5. 固定 API 与实现接口

基址 `/api/core/data`；所有端点 requireAuth，`all` 额外检查 admin：

- `GET /export?scope=own|all`：下载 JSON snapshot。
- `POST /preview`、`POST /import`：`{scope, snapshot}`；返回概要以及 `tables: [{table, inserted, skipped, conflicts}]`（preview 的数量是预估，import 必须重新验证）。
- `GET /webdav`：`{configured, endpoint, username, hasPassword, scope, intervalHours, nextRunAt, lastRunAt, lastStatus, lastError}`。
- `PUT /webdav`：endpoint、username、可选 password、scope、intervalHours (`0|1|6|12|24|168`，0=关闭自动)；`DELETE /webdav` 删除本人配置。
- `POST /webdav/test {}`；`POST /webdav/backup {}`；`GET /webdav/history` 返回 `{items}`；`GET /webdav/files/:id` 下载本人成功记录的快照，随后统一 preview/import。
- snapshot 服务导出、预览、合并函数均显式传 actor `{id, role}`、scope、Database、storageRoot；不自行从环境选生产数据库，不接受任意 SQL/表名。
- `core.settings` 中 runtime 相关键（如 platform.timezone）在本批不合并；保留当前运行态，不造成 TimeService 与 DB 分离。平台呈现设置以固定 key allowlist 合并。

## 执行顺序与文件范围

1. 本清单 → 独立 reviewer 检查点 → 冻结，才开始广泛实现。
2. advanced-worker：snapshot allowlist/校验/export/merge、附件协议及回归；离线转换/export CLI。
3. advanced-worker：Core 配置前向迁移、加密 WebDAV、持久自动备份、路由权限与集成回归；和步骤 2 定义共享接口后并行。
4. worker：Settings 数据面板、API client、导出/选择文件/预览合并、WebDAV 配置和历史备份、自动备份状态及 UI/E2E；只按确定的 API 实施。
5. 集成、文档、canonical gates、独立 final-reviewer；修复审阅缺陷需补语义回归；随后按用户授权及当前 Git 操作规则提交/推送/CI，未完成步骤如实列明。

允许范围：新 `backend/src/core/data-management/`、`backend/src/core/platform.ts` 的最小接线、新 `migrations/core/` SQL、前端 Settings 数据管理组件/API/必要样式、相应单元/集成/UI/E2E、离线导出脚本、环境变量/Docker env 透传文档及必要配置、README/迁移说明/本清单。为 XML 安全解析等必要依赖可改 package/lock。既有 CLI restore 语义保留。不得改旧迁移、App Contract、通用 Storage/Scheduler 权限语义或无关 App 行为。

非目标：任意 SQL 在线执行、物理全库在线覆盖、跨 App 常规 API、WebDAV 同步盘/双向实时同步、自动远端删除、将历史资料导入未适配的未知 App。

## 验收与回归矩阵

| 范围 | 必须验证 |
|---|---|
| 权限 | 未登录 401；普通用户 all 403；本人导出无别人数据/秘密；本人导入伪造 owner 不越权；配置按 user 隔离 |
| 导出 | 全 App/disabled 数据、两种 scope、同一 DB 快照、DATE 原值、附件字节/hash；未知表/附件缺失明确失败；限制边界 |
| 合并 | 重复幂等；已有数据保留；id/username 任一冲突拒绝；同名 tag/category 关系重映射；UUID 跨 owner 拒绝；外键/跨 owner/active focus 冲突全回滚；并发写入/导入 |
| 文件 | 二进制往返；重映射用户目录；不覆盖现有 key；写失败/DB失败清理；无路径穿越/symlink；重复导入不多文件 |
| 历史格式 | 现有 CLI directory → 独立 DB/storage → 前向迁移 → JSON export → Settings merge；在线 SQL 明确拒绝 |
| 配置迁移 | fresh 和此前 core 数据升级；既有账户/App 数据保留；重启配置仍在；密钥缺失/错密钥可观测；密码不出现在响应/导出/日志 |
| WebDAV | 本地真实 mock server 的认证、PUT/list/GET 往返；401/403/超时/失败/超限/重定向；非法历史 ID 与跨用户历史；成功唯一文件名；无真实网盘凭据不宣称真实供应商验收 |
| 自动备份 | 配置持久化/到期执行/重启补一次/关闭；手动与定时互斥；账号禁用/降权；失败下次调度与状态；shutdown 不留计时器 |
| UI | admin scopes / user own；下载、上传预览与确认、错误/计数；密码不回显；保存配置/手动备份/自动开关和状态；下载历史包再合并 |
| 门禁 | npm run check、npm run build、npm test、npm run test:integration、npm run e2e、SKIP_INSTALL=1 ./scripts/verify.sh、git diff --check、git status；独立终审；实际 Git/CI 状态如实报告 |

## 状态

- 兼容性精化：当前 schema 指纹覆盖列名/类型/可空性，目标约束在预览与导入中执行；不把它当作迁移历史或语义版本证明。后续仅改变语义的迁移需显式审查适配器/格式兼容性。
- 终审修复：COMMIT 确认失败可能已提交，导入仅在事务体失败时清理新文件；提交结果不确定时保留文件并报告可重载/幂等重试。真实提交后模拟断连的回归已加入。

- 实施补充：生产 Nginx 原限制为 12 MiB/默认 60s，阻塞 32 MiB 数据包和有界导出；允许仅 `/api/core/data/` 的 33 MiB（含 envelope）与 180s 读取超时配置，并加入 Docker 配置回归。其他 API 限制保留。

- 架构建议：完成；reviewer 所要求的权限、身份、密钥、网络 origin 限制与历史记录绑定修订已纳入。
- 用户范围确认：两种 scope；WebDAV 手动与自动均需要，已在实施前纳入。
- 独立 reviewer checkpoint：ACCEPTED，2026-11-01 冻结；可按上述任务拆分实施。最终验收仍需实际实现审查及完整门禁。
- 实现：本人/全站快照、预览与合并、附件、旧 CLI 转换、WebDAV 私有配置/手动/自动/历史下载和 Settings 界面完成。
- 独立 final-reviewer：ACCEPTED；确认提交不确定性、JSON null、时区及空游戏存档兼容回归均已修复。
- 最终本地 canonical verify：check/build、后端单元 209/209、前端 492/492、PostgreSQL 集成 390/390、迁移及真实认证冒烟全部 PASS。E2E 50/50（含桌面/手机布局）PASS；Docker 配置回归 9/9 PASS；diff 检查 PASS。
- 本地 WebDAV 真实模拟服务器已覆盖协议/认证/失败边界；没有真实网盘凭据，未声明供应商部署验收。远端 GitHub Actions 以本分支提交对应运行结果为准。
