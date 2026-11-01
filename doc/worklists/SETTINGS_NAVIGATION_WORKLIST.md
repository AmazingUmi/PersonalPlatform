# Settings 导航与控件一致性

## 目标与当前缺口

用户指出 Settings 将全部功能堆成一页，缺少分页/导航，文件选择还暴露未样式化的原生按钮。本批整理前端信息结构，复用既有 PixelButton/PixelInput，不改变数据管理协议或后台行为。

## 架构与界面决定

- Settings 主导航按 `General / Data / WebDAV / Users` 分区，默认 General；Users 仅管理员可见。桌面导航与内容分栏，窄屏导航自然换行，不挤压内容或造成横向页面溢出。每次仅显示一个主分区。
- 使用 `/settings?section=general|data|webdav|users` 保存位置；导航写入历史，刷新、直接链接及浏览器前进/后退均生效。非法/缺省 section 回到 General，普通用户请求 Users 回到 General。保留不属于本功能的 query 参数。
- WebDAV 再按 `Connection / Backup / History` 切换内容，使用 `view=connection|backup|history`；连接与定时配置、立即备份及状态、历史记录分别呈现，避免再次堆成长页。首次进入默认 Connection。
- 分区首次访问时才加载，访问后在同一 Settings 页面内保持组件状态；切换主分区/子视图不丢失已选文件、合并预览或未保存 WebDAV 输入。仅当前视图可见、可键盘聚焦，隐藏视图使用真正的 hidden 容器。密码不写 URL、localStorage 或 sessionStorage。
- 远端 History 的 Review 自动切至 Data 并聚焦其标题，再显示下载/重建进度、来源与预览；错误也在这个可见区域展示。新的远端下载/预览成功前保留原导入草稿，不因失败误清空。处理中切换分区仍保留任务状态，禁止重复提交。
- History 对后端已有最多 100 条记录做客户端分页，每页 10 条；显示当前页与已加载记录总数，明确“最近最多 100 条”，不声称能翻到全部远端历史。空列表不显示无意义分页；刷新/删除配置后页码夹到有效范围。页码可保存在 query `page`，非法值回到第 1 页。
- 主导航、WebDAV 视图导航、分页及操作控件沿用同一像素按钮语言。所有操作使用 PixelButton，统一默认 md 尺寸；primary/secondary/danger/ghost 根据操作语义区分，不能以“统一”抹去危险操作提示。导航用带 `aria-current` 的 Link 并复用 px-button 类，保持可打开新标签页的真实链接语义。
- 文件选择改成隐藏原生 input + 真正 PixelButton `Choose file`，点击/键盘激活系统文件选择器；保留 input 的可访问名称 Backup file 供辅助技术与测试定位。相邻显示文件名或 No file selected，长文件名可换行；选择、取消、清除、相同文件重新选择及 busy 禁用都保持正确。
- 历史条目的文件名属于内容，不能再塞入按钮文字；采用短 `Download` / `Review` 按钮，以每条记录的 aria-label/关联标题区分操作对象。General 删除“above”等依赖旧堆叠位置的文案，不增加与用户操作无关的实现细节。

## 执行、允许范围与非目标

1. 本清单独立 reviewer checkpoint 后冻结。
2. Settings 查询导航/可见性与数据面板拆分；文件按钮、短历史操作与分页；必要的本地样式。
3. 语义测试、桌面/手机真实浏览器视觉检查、canonical gates、独立终审、提交/推送/CI。

允许：`frontend/src/shell/Settings.tsx`、`DataManagementPanel.tsx`、其专属新组件/样式、前端单元与 E2E、本清单和相关使用说明。必要时给 PixelButton 增加不含 Settings 语义的可复用能力，但优先不改共享组件。

非目标：后端/Core、数据库或迁移、备份格式/权限/增量算法、服务端历史分页、其他 App 重构、新 UI 框架、主题改造。URL 只保存导航状态，不保存敏感表单或备份内容。

## 验收与回归

| 情景 | 预期 |
|---|---|
| 默认/直接链接/刷新/back/forward | 显示对应唯一分区/子视图，非法查询安全回退 |
| 普通用户 | 无 Users 导航或账号管理请求；备份仍仅本人范围 |
| 草稿与操作状态 | 分区切换不丢文件/预览/未保存配置，不重复提交 |
| History → Review | 自动跳 Data 并聚焦；成功展示正确来源/预览，失败错误可见且保留原草稿 |
| 历史分页 | 0/1/10/11/100 条、末页、刷新缩短、非法页码正确；不误称全量远端记录 |
| 文件选择 | 可见 PixelButton、键盘可用、真实 chooser、显示/清除/重选同文件及 busy 禁用 |
| 视觉 | 1280、768、390、320px 可用；导航清楚、按钮一致、长文件名无溢出、隐藏内容不占高不进入 tab 顺序 |
| 原工作流 | 全量导出/预览/合并、WebDAV 增量/全量/状态/历史下载、用户创建仍可用 |
| 门禁 | check/build/unit/integration/E2E/verify、diff/status；独立 final-reviewer；干净工作区与远端 CI 成功 |

## 状态

- 独立 reviewer checkpoint：ACCEPTED。已对照现有 Settings/DataManagementPanel 验证分区、草稿生命周期、跨区 Review、权限与客户端分页边界；本清单冻结，可进入实施。
- 实施完成：四个主分区、WebDAV 三个子视图与 10 条历史分页；统一 PixelButton 文件选择和操作，保留草稿，远端 Review 自动跳转并在失败时保留原草稿。无后端/Core 变更。
- 本地验收：`SKIP_INSTALL=1 ./scripts/verify.sh` PASS（check/build、219 后端单元、513 前端单元、398 集成、全新迁移与启动冒烟）；`npm run e2e` 52/52 PASS；`git diff --check` PASS。
- 视觉验收：真实浏览器检查 1280/768/390/320px 的四个分区、手机文件选择和长文件名历史；无页面横向溢出，导航及操作保持像素样式。
- 独立 final-reviewer：ACCEPTED，无实施阻塞项。提交后由对应 GitHub Actions 记录远端验收结果。
