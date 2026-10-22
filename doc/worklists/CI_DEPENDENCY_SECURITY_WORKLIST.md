# CI 依赖安全门禁修复

## 目标与证据

用户授权提交推送后，`f0d0dcf` 已推送至 origin/main。Actions run `39803292204` 的 Docker job、check/build/unit/integration 均通过，但 `npm audit --audit-level=high` 失败，后续 E2E 被跳过。本地只读 audit 同样报告 6 high、2 moderate。

## 决策与范围

- 仅刷新现有 semver 范围内的受影响依赖及关联依赖链；不使用 force、不引入 major 升级或 override，不修改业务/Core/合同/历史迁移/CI 阈值。
- npm dry-run 预览 17 项 change、无 add/remove；涉及 Fastify 5.12.x、Vite 6.4.x、Vitest 4.1.x 及其关联依赖、fast-uri、brace-expansion、source-map-js、undici。
- 允许修改仅 `package-lock.json` 和本清单；package manifests 保持不变。应用后先核对完整 diff 与版本范围，再从锁文件安装验证；意外扩大的差异先退回评估。
- 安全缺陷回归使用既有 audit 门禁：旧锁文件为 RED，更新后必须 audit 为 0；不复制第三方库的实现测试。

## 任务与验收

1. Architect/reviewer checkpoint → 冻结本清单。
2. 应用兼容更新、核对 diff、`npm ci` 与 audit。
3. 运行 check/build/unit/integration/E2E/verify、Docker 回归、diff 检查；仅使用隔离数据库和临时平台目录。
4. 独立 final-reviewer ACCEPTED 后单独提交并推送；等待新提交远端 CI。

非目标：其他审阅问题、功能改动、Node 支持版本调整、Actions action 版本升级。

参考：npm 官方 `npm audit` 文档及 maintainer advisory。这里的 audit 结果不等同于当前应用每条漏洞均可被利用。

- https://docs.npmjs.com/cli/v11/commands/npm-audit/
- https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7

## 状态

- 旧锁文件：audit RED，6 high / 2 moderate；dry-run 仅现有版本范围更新。
- 架构与 reviewer checkpoint：ACCEPTED；2026-10-22 冻结。确认 Vitest 同组精确版本一起更新、fast-uri 两个分支保留；实际应用后复核 engines、依赖边与 registry/integrity。
- 实施：17 项同 major 更新，无增删包；仅 lockfile 的版本、registry/integrity 与 Vitest 同组 dependency/optional-peer 元数据更新。engines 均未变；chai/tinyrainbow 属于 Vitest 现有依赖链。
- `npm ci` 退出 0；更新后独立 `npm audit --json` 退出 0，漏洞总数 0。
- 全量回归：check/build/test/integration/verify 退出 0（backend 193、frontend 448、integration 352）；E2E 44/44，退出 0；生产 Docker 构建/启动/迁移/持久化验证退出 0；`git diff --check` PASS。
- 独立 final-reviewer：ACCEPTED，无阻塞项。用户已授权提交推送；单独提交本补救，推送后核对新提交的远端 CI，未在此预先声明远端通过。
