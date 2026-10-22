# 恢复与附件对账数据安全

## 目标与缺口

Docker 批次已提交为 `4163be5`。继续修复两个已确认的数据丢失风险：恢复 CLI 在独立连接先提交 DROP，随后导入失败无法回滚；Assets 对账把存储 exists=false 直接当作缺失删除 metadata。

## 决策与顺序

### A 恢复

- 在单个 `psql -X --single-transaction -v ON_ERROR_STOP=1` 调用中执行所有 schema DROP 与完整 SQL 导入；不读取本机 psqlrc，不在错误日志输出含口令的连接参数。
- 仅支持本工具可信的 plain SQL/tar 备份，不扩展为任意不可信导入器。识别 SQL 顶层 canonical schema 声明，跳过注释、字符串、dollar body 与 COPY 数据，避免把数据内容当作 DROP 目标；不从 manifest 猜测全库备份的 scope。
- 数据库变更前完成 SQL/metadata 读取、archive 解包和 storage/config 预复制。保留当前 storage/config 的恢复副本，不再先删除唯一旧文件副本。
- 数据库与文件系统没有共同事务。SQL 失败不安装文件；数据库提交后文件安装失败必须报告部分完成，并保留旧树与待安装树供恢复。备份恢复需停后端/调度，不声称整体原子或崩溃自动恢复。保留目录复制方案以支持 volume 挂载点，不假设整个 storage 根可 rename。
- 子进程失败抛异常，由顶层设置退出码，让 finally 清理正常失败的 staging；部分完成保留 staging 并明确路径。

### B 附件对账

- App 内保留 exists=true 快速路径；false 时用同一用户 storage.read 确认。
- 仅明确的 `StorageError(not_found)` 才删除匹配 id/user_id/storage_key 的 metadata。read 成功、io_error、invalid_path、未知错误均保留；失败日志及 additive `probeFailed` 计数让维护操作可观测，其余附件继续检查。
- 不改变冻结 Core/Storage Contract，不引入所有正常大附件的全量读取。

先通过 A 的针对性检查和 reviewer 检查点，再实施 B；两项完成后统一 canonical gates 和独立终审。

## 任务与允许范围

1. 架构建议 → 本清单 reviewer checkpoint → 冻结。
2. A 的失败回滚、归档预检、文件安装失败回归先复现，再修 CLI。
3. B 的真实目录/symlink 故障及 facade 误报回归先复现，再修对账。
4. README、恢复操作文档与 Assets README 更新准确边界；canonical gates、Docker 回归与独立终审。

允许：`scripts/backup.ts`、恢复 scope 识别 helper、backup 专属单元/集成测试、`backend/src/apps/assets/`、Assets consistency 专属测试、README/恢复相关文档、本清单、排除恢复暂存数据所需 ignore 规则。

验收中范围修订：全新生产卷的实际 Docker 验证发现 PostgreSQL 的 Unix socket 健康检查会误认 initdb 临时服务器为就绪，后端先于最终 TCP 服务启动而 ECONNREFUSED。该缺陷阻塞本批镜像门禁，允许最小修改 `docker/docker-compose.prod.yml` 的 TCP 健康检查及 `scripts/test/docker-config.test.mjs` 回归；不改变 Core 或启动重试语义。保留失败日志并重跑全新卷验证。

非目标：Core、历史迁移、App Contract、UI、其他审阅项、生产发布与推送。用户已明确授权提交本批；后续批次不自动提交。

## 验收矩阵

| 情景 | 结果 |
|---|---|
| 多 scope SQL 后半失败 | 全部原 schema/哨兵数据保留，storage/config 不变 |
| COPY/函数/字符串内伪 schema 声明 | 不误删目标库中无关 schema |
| archive 损坏、无 storage 根或预复制失败 | 数据库未变更，旧文件保留，正常失败清理 staging |
| 成功、重复恢复 | 数据库、附件、配置与备份一致 |
| DB 提交后文件安装失败 | 非零退出，明确部分完成；旧树/待安装树仍在可报告的 staging |
| exists=true / false但read成功 | 保留 metadata，正向不读文件 |
| 明确 missing | 删除 metadata，重复对账幂等 |
| I/O、目录、symlink、未知错误 | 保留 metadata、可观测，故障清除后恢复读取 |
| 多用户 | 逐行按所属用户 storage 探测，不跨用户访问 |
| 工程 | check/build/unit/integration/E2E/verify、Docker验收、diff检查、独立终审；远端CI未运行时明确标注 |

## 状态

- 架构：ACCEPTED。
- Worklist checkpoint：ACCEPTED；2026-10-22 冻结。
- A：实现完成，helper 单元 5/5、PostgreSQL 恢复集成 9/9、后端类型检查通过；reviewer checkpoint ACCEPTED。复审补充拒绝 storage/config 根 symlink，并区分普通 SQL 字符串与 E 字符串，均有回归。
- B：实现完成，PostgreSQL consistency 集成 24/24、后端类型检查通过；新增 15 个用例已在旧实现 RED 后转为 GREEN。Reviewer checkpoint ACCEPTED。
- Canonical verify：check/build、后端单元 193、前端 418、集成 345、迁移与后端冒烟 PASS；E2E 42/42 PASS。
- Docker：首次全新卷启动暴露上述健康检查竞态；已修复，配置回归由 RED 转为 5/5 PASS。重新构建并以全新隔离卷启动、迁移、真实登录、代理、附件和容器重建持久化验收 PASS，临时项目资源已清理。
- 独立终审：ACCEPTED，本批本地验收通过；用户已授权提交。未推送，GitHub Actions 未运行，远端 CI 验收待执行。
