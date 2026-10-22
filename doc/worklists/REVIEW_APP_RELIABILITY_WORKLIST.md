# 审阅修复：附件安全与客户端状态

## 目标与当前缺口

数据安全批次已提交为 `c93f685`。本批按安全与数据完整性优先级，串行修复三个仍存在的 App 局部问题：附件按不可信 MIME inline 返回；Quick Note 保存响应清空期间的新草稿；Focus 旧 GET 覆盖操作结果且倒计时依赖客户端墙钟。

## 架构决策

### A 附件响应

现有 Assets 只提供文件链接，没有嵌入预览。所有附件统一以 `application/octet-stream`、`Content-Disposition: attachment` 返回，增加 `nosniff` 和局部限制性 CSP；原 MIME 仅作 metadata。文件名使用安全 ASCII fallback 和 RFC 5987 UTF-8 `filename*`，控制字符、引号、反斜杠不能进入未转义 header。保留 bytes 和用户归属校验。前端链接明确下载，不再主动打开新标签。

### B Quick Note

保持保存期间可编辑。提交时捕获 content 与编辑 revision；成功仅在 revision 未变时清空，期间编辑过则保留整个当前草稿，包括 A→B→A。失败保留草稿；Saved/Open 指向已提交的 note。沿用 shared/useMutation 防重，不改变共享 mutation 约定。

### C Focus

统一 GET 应用入口，以 request sequence、mutation generation、mount epoch 拒绝过期成功与错误。操作开始即使旧 GET 失效，操作成功或 409 返回的权威 state 优先应用；busy 期间不新发 GET，普通并发读取仅接受最后发出的请求。任何被接受的最终结果均正确收束 loading；卸载/StrictMode 清理使旧请求失效。

倒计时使用已存在的 `FocusState.now` 加接收后 `performance.now()` 的单调增量；每个被接受的 state（含 409）重新校准。暂停保持快照，运行值不小于零。服务器响应在途延迟仍有误差，不声称精确时钟同步；恢复可见时立即重读校准。不改后端 API、事件或 revision 合同。

## 任务、依赖与允许范围

1. 架构建议 → 本清单 reviewer checkpoint → 冻结。
2. A 先补回归复现，再实施，targeted 测试和 reviewer checkpoint 通过后进入 B。
3. B 同上，完成后进入 C。
4. 三项完成后统一 canonical gates、真实浏览器下载/草稿流程、生产镜像回归及独立终审。

允许：Assets 后端下载处理及必要的 App 局部 helper、Assets 前端下载链接/对应测试、Assets 专属集成测试和 README；QuickNoteWidget 及其测试、Notes README；Focus useFocusState 及其测试、Focus README；`frontend/e2e` 针对上述用户流程；本清单。

验收中的范围补充：`backend/test/integration/apps.test.ts` 的既有 Assets 下载用例仍要求响应 MIME 为上传的 text/plain，导致统一门禁失败。仅将该响应断言更新为已批准的 octet-stream/attachment/nosniff 合同，保留元数据 MIME、字节及 404 校验，不改其他 App 用例。

非目标：冻结 Core、平台生命周期、历史迁移、shared hook/UI、settings/权限/布局、并发 SQL/性能优化。生命周期问题已升级架构评估，须单独 worklist/checkpoint，不能混入本批。用户已明确授权本批提交并推送。

## 验收矩阵

| 任务 | 必需回归 |
|---|---|
| 附件 | HTML/SVG/伪装 image MIME 均下载且无执行；bytes 一致；Unicode/恶意文件名不注入或500；原归属404；真实浏览器 download 事件 |
| 草稿 | 未编辑成功清空；保存期间编辑成功保留；A→B→A保留；失败保留；重试提交当前内容；double submit 单请求；expanded recent 仍刷新 |
| Focus 顺序 | 旧GET晚于POST/409返回不能覆盖；乱序GET成功/失败；过期错误不污染状态；initial被替代后loading结束；StrictMode/卸载忽略旧响应 |
| Focus 时间 | 客户端正负偏差和墙钟跳变不改倒计时；monotonic推进；暂停、零边界、跨tab、可见性/轮询行为不退化 |
| 工程 | check/build/unit/integration/E2E/verify、Docker、diff检查与独立终审；远端CI状态单独报告 |

## 后续队列

- P1：Core 生命周期并发、迁移/激活期间 API 开放（架构升级中，独立批次）。
- P1/P2：settings 读取失败后覆盖已有配置；Tasks 时间区间与关系集合并发一致性。
- P2：角色权限可见性、登出失败状态、确认框焦点、窄屏长名称；App 隔离门禁递归/违规 fixture。
- P3：summary 查询、列表分页、Widget 有界读取、bundle 拆分；先测量再优化。

## 状态

- 架构：三个 App 局部方案已确认；生命周期另行评估。
- Reviewer checkpoint：ACCEPTED；2026-10-22 冻结。补充现有矩阵边界：截断 filename 的孤立 surrogate 不得500；单独控制 monotonic 时钟验证墙钟跳变；initial GET 被失败 mutation 替代后 loading 也结束。
- A：实现完成；集成回归 7/7 PASS（旧实现 6 FAIL）；真实 Chrome 下载用例 PASS，含 setup 2/2；前后端类型检查与 diff 检查通过。Reviewer checkpoint ACCEPTED。
- B：实现完成；QuickNote 单测 14/14 PASS，草稿竞态及 recent 首次请求 pending 均先 RED 后 GREEN；真实 Chrome 保存用例 PASS，含 setup 2/2；类型/diff 检查通过。Reviewer checkpoint ACCEPTED。
- C：实现完成；新增回归在旧实现 22 FAIL，最终 hook/Page/Widget 48/48 PASS，类型/diff 检查通过。旧 hook 测试的固定 server.now 改为随模拟服务器时钟推进，保留原倒计时/归零断言；其他组件测试未改。Reviewer checkpoint ACCEPTED。
- 完整 E2E：44/44 PASS，退出 0；含新增真实附件下载与草稿保存流程。
- 生产镜像回归：配置 5/5、build/boot、迁移、登录、代理、附件与容器重建持久化 PASS，退出 0，临时项目资源已清理。
- Canonical verify：首次集成 351/352，唯一失败为上述既有 MIME 断言；修正后完整重验退出 0，check/build、后端单元 193、前端 448、集成 352、迁移和后端冒烟全部 PASS，无数据库跳过。
- 独立终审：ACCEPTED，本批本地验收通过；用户已授权提交推送。推送后核对 GitHub Actions 结果，远端 CI 状态单独报告。
