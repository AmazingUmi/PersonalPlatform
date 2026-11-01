# 中英文界面与问号帮助浮层

## 目标与当前缺口

在 Settings 增加中文/英文切换，将项目界面内介绍性说明移到统一问号浮层。当前前端无语言机制，Shell 与六个 App 的标签、提示、空状态和日期多数固定英文；说明文字散落页面副标题、hint、小字与备份长段落中。

## 冻结架构与行为

- 本批为前端全界面改造：Shell、登录、Settings（含数据管理/WebDAV）、App Center、Dashboard、六个 App 及其 Widget、共享状态/确认组件。语言值为 `en | zh`，展示 locale 为 `en-US | zh-CN`；不改 Core、数据库、迁移、App Contract V1 或接口值。
- 轻量 React `I18nProvider` + `useI18n()`，返回 `{ language, locale, setLanguage, t(en: string, zh: string): string }`。配对文案保留在所属组件/模块，使 App 自持语义并避免大共享业务字典。纯函数按需接收 language/locale，禁止靠可变全局语言或 DOM 文本替换实现翻译。
- Settings → General 提供 `Language / 语言` 下拉项 `English`、`简体中文`。切换立即生效，不重载页面、不改变组件 key、不丢编辑草稿。语言保存在当前浏览器 localStorage；首次按浏览器语言选择，中文语言映射 zh，其余回退 en；无效保存值安全回退，存储不可用仍可本次切换。页面明确此偏好仅限当前浏览器，不宣称跨设备或账号同步。Provider 外的组件默认英文，维持现有单元测试隔离。
- 同步 `document.documentElement.lang`；登录页/引导/错误页均受 Provider 作用。跨标签页同步有效语言设置。日期/时间/数字和单位文案使用所选 locale；不改变 TimeService 时区、日期边界或业务值。可编辑 date/time 原生控件继续使用标准 value。
- 翻译前端拥有的标题、操作、表头、placeholder、aria-label、菜单、状态、空态、帮助与确认文案，包括动态数量及复数。受支持 App 的默认名称/简介按 app id 本地化；用户昵称优先且原样保留，未知 App 元数据保留原文。
- 用户标题、笔记、分类/标签、文件名、账号名、用户自定义城市/标签和 API/路由/schema 枚举值不翻译。已知 API 错误通过稳定 code 或明确受控消息映射本地化；未知技术诊断保留原文，不对任意服务端或用户内容做字符串替换。保留诊断所需信息。

## 统一 HelpPopover

- 新增 `shared/ui/HelpPopover`，接口 `{ label: string; children: ReactNode }`，不含任何 App 语义。使用像素样式的真正 `?` 按钮；可访问名称为本地化 Help + label；与相邻标题/字段关联。
- 鼠标悬停或键盘聚焦可看说明；点击/触摸可保持打开。支持 Escape、外部点击及合理失焦关闭。进入浮层阅读/点击链接不能立即消失；从键盘关闭后不得因仍聚焦而立刻重新打开。含链接内容采用可访问的非模态弹出区域语义，不能把可交互内容塞进纯 tooltip 语义。
- 使用 portal 或同等可靠的定位，避免 Widget、滚动容器和 overflow 裁切；随滚动/尺寸变化更新位置，在 320px 窄屏及屏幕边缘内夹紧，长内容可滚动。卸载时移除事件/计时器。不得嵌套 button/link，不触发父级卡片导航、提交或拖拽。
- 收纳对象：页面介绍副标题、字段补充说明、操作方式介绍、功能限制/备份格式解释、游戏键盘说明等。可组合相近说明，避免一段一句一个问号。原文本移入帮助，不复制为隐藏的重复页面段落。
- 保持直接可见：错误、验证失败、成功反馈、加载/运行状态、未保存修改提示、权限不可用提示、危险操作/敏感数据警告、计数/记录元信息及操作按钮。空状态标题和行动按钮保留；介绍性补充可以进入帮助。用户内容和当前记录状态即使使用 muted/hint 类也不能机械隐藏。

## 分工与允许文件

1. 独立 reviewer 检查本清单，ACCEPTED 后冻结进入实施。
2. 主代理：i18n、HelpPopover、共享控件、Shell/Settings/Login、默认 App 元数据、跨语言 E2E 与集成协调。
3. Worker A：`frontend/src/apps/assets/`、`tasks/` 的界面本地化和介绍性帮助，所属测试；不改其他共享基础。
4. Worker B：`frontend/src/apps/clock/`、`focus/`、`notes/`、`mini_game/` 的同类改造，所属测试；不改业务/计时算法。
5. 主代理完成遗留字符串巡检、canonical gates、真实浏览器视觉/键盘/触屏检查、独立终审、提交/推送/CI；按本会话本机 Docker 工作流更新已验证前端并检查健康。

允许 `frontend/src/**`、`frontend/e2e/**`、必要前端测试配置与使用/开发说明、本清单。可增加共享 UI/I18n 回归；生成 registry 仅按现有生成器处理，不手改。非目标：服务端账号语言偏好、第三语言、在线机器翻译、后台业务国际化、自动翻译用户资料、界面主题重做、迁移或 App 行为重构。

## 验收与回归矩阵

| 场景 | 预期 |
|---|---|
| Settings 中英文来回切换 | Shell、当前面板、提示及之后打开的每个 App/Widget 跟随；标签/文案不混用 |
| 保存与初始语言 | 刷新保留；浏览器中文初始 zh；非法值和存储失败安全；跨标签页更新；HTML lang 正确 |
| 切换中的编辑/业务 | 文件预览、未保存表单、笔记、任务编辑及运行计时器不丢失、不重置 |
| 用户数据与元数据 | 用户内容/昵称保持原样；默认 App 名称和简介中英文一致；未知 App 可用 |
| 日期/数字/错误 | 所选 locale 生效，时区逻辑不变；已知错误可读，未知诊断保留 |
| 问号交互 | 鼠标悬停、进入浮层、键盘 focus/Enter/Escape、手机点击/外点关闭、内部链接可用 |
| 视觉与边界 | 1280/768/390/320px、顶部/底部/右侧触发器无裁切或全页溢出；中文字体/按钮不挤压 |
| 说明语义分类 | 介绍性段落收纳；错误/警告/忙碌/结果/当前记录元信息保持可见 |
| 既有功能 | 认证/导航/App 生命周期/Widget 布局/CRUD/附件/计时/备份导入和 WebDAV 流程回归 |
| 完整验收 | check/build/unit/integration/E2E/verify、diff/status、独立 final-reviewer、干净工作区与远端 CI success |

## 状态

独立 reviewer checkpoint：ACCEPTED。已对照现有 Shell、PresentationContext、PixelWindow、共享确认控件及各 App 的说明/状态文本检查；前端全界面范围、浏览器语言持久化、昵称与用户内容保护、帮助浮层交互和不隐藏运行状态的边界合理。本清单冻结，可进入实施。实现开始前由主代理向两位 Worker 固定上述 I18n 与 HelpPopover API。

## 实施与验证记录（2026-11-02）

- 已覆盖 Shell、登录、Settings/Data/WebDAV、App Center、Dashboard 及六个 App/Widget；统一 HelpPopover 支持 hover/focus/click/touch、Escape/外点关闭及 portal 视口定位。错误、状态、未保存提示和敏感数据警告仍直接可见。
- 浏览器语言持久化、非法值/存储异常、跨标签页同步、HTML lang、默认元数据与自定义昵称、已有异步错误即时翻译均有回归。切换语言不重发请求，不重建计时器/音频订阅，不丢 WebDAV/任务/专注/笔记等草稿。
- 独立审查发现 Assets 分类颜色的翻译标签误用于 option value；先用回归复现，再修复为稳定 accent token，验证中文选择、切回英文及 PATCH 仍发送 `mint`。另外补充仅自定义颜色时不保存翻译后的默认昵称的回归。
- `SKIP_INSTALL=1 ./scripts/verify.sh` PASS：类型与生成检查、构建、221 后端单元、543 前端单元、403 集成、迁移及后端健康/应用冒烟全部通过，未跳过数据库阶段。
- `npm run e2e`：58 PASS，覆盖新增语言持久化、跨标签页草稿、六个应用中文导航、浏览器中文首次登录及反馈、键盘/触屏帮助。1280/768/390/320px 浮层边界通过；已查看桌面中文设置及平板/窄屏帮助截图。旧 WebDAV 测试收紧为 combobox role，避免与新帮助按钮的 accessible name 模糊匹配。
- Docker 生产前端镜像构建 PASS；`git diff --check` PASS。本批未修改 Core、后端、数据库迁移或生产 WebDAV 允许地址配置。
- 独立 final-reviewer 已复查实际工作区，实现无阻塞问题；最终通过记录与部署/远端 CI 结果由本会话交付记录提供。
