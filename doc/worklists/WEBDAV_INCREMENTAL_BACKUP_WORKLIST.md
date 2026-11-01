# WebDAV 增量备份

## 目标与授权范围

用户要求 WebDAV 改为增量备份，手动本地导出/导入继续使用完整 JSON；补充要求 WebDAV 手动操作也能选择完整备份。定时默认增量，手动 WebDAV 默认增量、可选完整。

这是既有 Core 数据管理服务的限定演进；允许新的前向 Core 迁移及服务/UI/测试/恢复 CLI 改动，不改旧迁移、App Contract V1、App 业务行为或已有合并规则。

## 架构决定

### 存储与增量语义

- 使用**不可变内容对象 + 每个备份点的完整引用清单**，不采用必须逐段回放的线性差分链。第一次建立对象基线；以后只 PUT 新增或内容变化的对象及很小的清单，未变对象复用。
- 每张表按主键的 SHA-256 固定分到 16 个桶（空桶不写对象），桶内按主键稳定排序。递归规范化 JSON 对象键后计算 SHA-256；单行改变仅重写所属桶，插入/删除不令后续所有桶移动。关系表使用现有复合主键。附件按原始字节摘要独立成对象，同一 namespace 相同内容只上传一次。
- 清单记录完整 scope/source/schema、创建时刻、每张表的桶引用和每个 attachmentId 的内容引用。删除通过新清单不再引用相应行/附件表达；旧备份仍可重建原状态。清单为独立恢复点，不依赖上一个清单，但依赖其引用的不可变对象。
- `namespace = SHA256(JSON.stringify([ownerId, normalizedEndpoint, webdavUsername, scope]))`；对象/清单文件名采用固定 ASCII 格式并严格校验。本人/全站、不同用户、目的地和远端账号的对象不得互相复用。密码变更不改变 namespace。
- 内容指纹包含 scope/source/schema、桶及附件引用，排除本次 createdAt。未变数据且对象完整时不执行 PUT、不新增历史；若旧对象缺失则修复该对象后仍报告数据未变，并返回实际修复上传量。
- 这是网络上传与远端存储的增量；当前仍从同一只读事务生成完整逻辑快照以识别变更，不声称增量 SQL 扫描。重建后的完整 JSON 仍受 32 MiB / 100,000 行限制。

### 完整模式与兼容

- WebDAV 手动 `mode=full` 沿用独立 v1 JSON 全量文件；不删除历史、不重置增量对象库。随后增量备份继续复用对应 namespace 中已确认对象。
- 旧历史默认为 `full`；既有完整备份可继续下载/导入。手动本地 `/export`、`/preview`、`/import` 的格式、权限、大小和保留当前记录的合并语义不变。
- 下载增量历史时，服务器取得清单、获取引用对象并验证 SHA-256，重建标准 v1 完整 JSON，之后走现有预览/合并。清单中的历史删除只影响重建包；合并依然不删除当前数据库中的记录。

### 远端完整性与失败边界

- 对上一已提交清单确认过的对象，HEAD 校验存在与长度；404 重新上传，错误长度拒绝且不覆盖。HEAD 无法证明同大小内容未被外部篡改，此限制写入文档；下载/恢复必须逐对象验 hash。
- 作为已确认引用或未变化判断依据的上一清单，必须先 GET 并校验数据库记录的 SHA-256/长度及结构。清单缺失或损坏时明确失败并提示完整备份/离线恢复，不能把不存在的恢复点报告为 unchanged。
- 首次遇到的对象条件 PUT (`If-None-Match: *`)；若 412，GET 并验证摘要/长度后才能复用，覆盖中断遗留/碰撞路径。非预期 HTTP 状态、重定向、损坏 JSON/引用及错误摘要均失败关闭。
- 全部对象验证/写入后才上传新的不可变清单；随后在一个数据库事务提交历史元数据。失败不推进成功历史，已有备份不变。可能留下未引用对象/清单，重试可复用已校验对象；不自动删除远端对象。
- 使用既有每用户 lease，增加/保留条件所有权校验。导出最多 120s，所有远端 I/O 共享 180s 总预算（含下载/恢复），低于现有 600s lease；每请求超时取剩余预算与 30s 的较小值。对象数上限 1024，传输/解析累计大小有界；超限明确失败，不能静默退回全量。
- 新前向迁移给 history 增加 `kind`（旧行 full）、namespace/content fingerprint、逻辑大小与上传字节/对象统计，以及单调 sequence 用于稳定选择最近同 namespace 清单（不以可相同的时钟时间猜先后）。现有 `sha256`/`size_bytes` 始终校验实际远端主文件（full JSON 或 manifest）。不保存第二份全量用户数据到 Core。
- 账号状态与 all 权限在开始和发布前复查；配置变更、历史下载的权限、目的地绑定、DNS pinning、origin allowlist、密钥保护与手动/定时互斥保持。
- 新历史另存 `destination_username`，下载必须同时匹配当前 endpoint 和远端用户名；旧历史该列为 null，保留既有 endpoint 绑定兼容路径。新增已确认对象索引如被采用，key 同样包含 owner/endpoint/username/scope，不包含对象明文。

### 无本地历史时恢复

- 提供离线 CLI：显式 `--manifest PATH --objects DIRECTORY --output FILE`，从用户用网盘客户端下载的清单和引用对象重建 v1 JSON。只接受固定文件名/namespace、普通文件，拒绝 symlink/路径穿越/摘要错误，输出 exclusive 0600。
- CLI 不连接生产数据库，不依赖本地 backup_history；重建后可在 Settings 预览/合并。文档要求保留清单及全部对象、不能只下载单个增量清单。远端自动发现/同步历史和远端垃圾回收不在本批范围。

## 固定接口与任务分工

- `POST /api/core/data/webdav/backup` 请求 `{mode?: 'incremental'|'full'}`，省略为 incremental；定时固定 incremental。
- 返回 `{status:'created'|'unchanged', backup: BackupRecord|null, uploadedBytes:number, uploadedObjects:number}`。数据未变而修复对象时 uploadedBytes/Objects 可大于零；UI 明确展示修复量，不声称零上传。
- 历史 `BackupRecord` 保留已有字段并添加 `kind:'full'|'incremental'`、`uploadedBytes`、`uploadedObjects`；`size` 表示重建的完整 JSON 大小，实际远端主文件大小为内部元数据。
- codec 接受现有 `Snapshot` 与确定 namespace，产出规范化 manifest、对象集合及内容指纹；reconstruct 接受 manifest 和受控对象读取函数，返回现有 `Snapshot`。codec 不访问 DB/网络/密钥。WebDAV service 拥有上传顺序、HEAD/条件 PUT、历史与预算。
- UI 增加手动模式选择、首次基线与后续增量说明、未变化/修复状态、历史类型与上传量；本地文件区明确全量 JSON。

执行：architect 清单 → 独立 reviewer checkpoint → codec/CLI worker + WebDAV/root + frontend worker → 专项与回归 → canonical gates → 独立 final-reviewer → commit/push/CI。

允许：`backend/src/core/data-management/`、新 `migrations/core/`、Settings 数据组件/API/样式、增量恢复 CLI、专属测试及相关数据管理文档。非目标：App 修改、通用 Core 重构、修改旧格式、实时同步、覆盖恢复、远端自动删除。

## 验收矩阵

| 情景 | 验收 |
|---|---|
| 首次/修改/新增/删除 | 首次对象基线；随后只上传新桶/附件+清单；各历史点重建内容精确匹配当时完整快照 |
| 未变/时间变化 | createdAt 不触发上传；无 PUT/无新历史；成功状态与下一次调度更新 |
| 附件 | 重复内容只一对象；未变附件不重传；新增/删除/重加正确；二进制字节/hash 精确 |
| 失败/修复 | 中途 PUT、清单上传、DB提交失败不损旧历史；上一清单丢失/损坏不得 unchanged；丢失旧对象可修复；同大小篡改恢复失败；412校验后复用 |
| 隔离/预算 | own/all/用户/目的地/远端账号隔离；降权禁用拒绝；手动/定时不重叠；总时间/对象/累计大小限额 |
| 全量兼容 | 本地完整 JSON 往返不变；手动 WebDAV full 独立可下载；旧 full 历史；full 后 incremental 仍复用 |
| 离线恢复 | 无本地 history，仅下载的清单+对象能重建；路径/symlink/hash/缺对象拒绝 |
| UI | 两手动模式、默认增量、未变化/修复提示、类型/字节量、下载后预览合并；普通用户权限不变 |
| 工程 | check/build/unit/integration/E2E/verify、diff/status、独立终审、干净工作区和 GitHub Actions 成功 |

## 状态

- 终审范围修订：导出最多 120s 加远端 I/O 180s，原代理 180s 不覆盖组合预算；仅调整 `docker/nginx.conf` 数据管理路由到 360s 并更新对应配置回归，不改变其他 API 超时。

- 架构完成；已纳入手动 WebDAV 可选完整模式。
- 独立 reviewer checkpoint：ACCEPTED，2026-11-01 冻结。上一清单完整性检查的审阅要求已补入，可开始按限定范围实现。
- 实现完成：增量对象/清单、附件去重、缺失修复/无变化跳过、WebDAV 手动全量、旧历史兼容、全量下载重建及离线 CLI；本地完整 JSON 导入/导出协议不变。
- 独立 final-reviewer：ACCEPTED。累计展开内存预检、lease 所有权重查、代理组合超时及 FIFO 输入拒绝均有回归；FIFO 回归先 RED 后 GREEN。
- Canonical verify：check/build、后端单元 219/219、前端 497/497、PostgreSQL 集成 398/398、迁移与真实认证冒烟全部 PASS。E2E 51/51、Docker 配置 9/9、diff 检查 PASS。
- 协议测试使用真实本地 HTTP WebDAV 模拟服务，未连接用户实际网盘；远端 GitHub Actions 以本批提交对应运行结果为准。
