# PersonalPlatform 像素风前端设计指南

> 文档定位：PersonalPlatform 前端视觉与交互改造规范  
> 设计主题：**Pixel Personal OS / 像素个人操作系统**  
> 适用仓库：`AmazingUmi/PersonalPlatform`  
> 适用前端：React 19 + React Router + Vite + TypeScript  
> 版本：v1.0  
> 日期：2026-08-29

---

## 1. 设计目标

PersonalPlatform 的核心不是某一个具体应用，而是一个能够持续承载 Tasks、Assets、Mini Game 以及未来更多个人模块的通用平台。

因此像素风改造不应只是：

- 把圆角改小；
- 换一套像素字体；
- 给按钮加粗边框；
- 加几个游戏图标。

完整设计应建立一个统一的 **Pixel Personal OS** 视觉系统，让整个 PersonalPlatform 看起来像一个属于用户自己的轻量像素操作系统。

核心隐喻：

| PersonalPlatform 概念 | Pixel OS 视觉隐喻 |
|---|---|
| Platform Shell | 操作系统桌面 / 系统外壳 |
| Dashboard | 系统主页 / Desktop |
| App Center | 应用库 / Cartridge Library |
| App | 独立程序 |
| Widget | 桌面小窗口 |
| Tasks | Quest Log / 任务日志 |
| Assets | Inventory / 物品仓库 |
| Mini Game | 原生小游戏 |
| Settings | System Settings |
| Enabled / Disabled | Installed / Active 状态 |

设计原则：

1. **功能优先，像素风是表现层，不改变业务逻辑。**
2. **统一 Shell，允许 App 保持自己的局部个性。**
3. **像素化边框、阴影、图标、标题，而不是把所有正文都做成低可读性的像素字。**
4. **轻量实现，第一阶段不引入大型 UI 框架。**
5. **所有新增 App 默认即可使用统一 UI primitives。**
6. **支持桌面、平板和手机，而不是仅为桌面像素游戏式界面设计。**
7. **避免赛博朋克、CRT、终端黑绿风；目标是明亮、温和、长期可用的 16-bit utility UI。**

---

# 2. 当前前端现状与改造判断

当前项目已经具备比较清晰的前端边界：

```text
frontend/src/
├── apps/
│   ├── assets/
│   ├── mini_game/
│   └── tasks/
├── generated/
├── shared/
├── shell/
│   ├── App.tsx
│   ├── AppCenter.tsx
│   ├── Dashboard.tsx
│   ├── Nav.tsx
│   ├── Settings.tsx
│   └── routes.ts
├── main.tsx
└── styles.css
```

现状优点：

- Shell 与 App 已分离；
- App 通过 module 注册 route/widget；
- Dashboard 已经是 widget container；
- App Center 已具备 enable/disable 生命周期；
- 前端依赖非常轻；
- 测试体系已存在。

目前主要视觉问题：

- 全局样式仍接近默认 SaaS 页面；
- 顶部导航随着 App 增加会越来越拥挤；
- Dashboard widget 与普通 Web Card 区别很小；
- App Center 仍是普通列表；
- Tasks / Assets 仅完成“能用”的表单与列表；
- Mini Game 与平台 Shell 没有统一视觉语言；
- 没有 design token；
- 没有可复用 UI primitive；
- 状态、图标、按钮、表单缺乏统一规则。

因此本次改造建议：

> **不修改 App 注册机制和后端 API，只重构 Shell、CSS design system 与显示组件。**

---

# 3. 总体视觉方向

## 3.1 风格名称

推荐内部设计名称：

**Pocket Pixel OS**

关键词：

- 16-bit
- Cozy
- Utility
- Personal
- Modular
- Clean
- Warm
- Crisp

不要做成：

- 纯黑背景 Hacker Terminal；
- 高饱和 Cyberpunk；
- 满屏游戏贴图；
- Windows 95 直接复刻；
- 大量 CRT scanline；
- 过度怀旧导致低可用性；
- 所有元素都带动画的“游戏 UI”。

---

## 3.2 视觉比例

建议保持：

```text
70% 现代生产力 UI
30% 像素游戏视觉语言
```

现代部分负责：

- 信息层级；
- 可读性；
- 响应式；
- 表单体验；
- 键盘操作；
- 长列表；
- 错误状态。

像素部分负责：

- 边框；
- 阴影；
- 标题；
- 图标；
- 状态徽标；
- 按钮；
- App Card；
- Widget Header；
- 页面装饰。

---

# 4. Color System

第一版建议使用浅色主题。

## 4.1 基础 Palette

```css
:root {
  /* Canvas */
  --px-bg: #ebe5d1;
  --px-bg-grid: #dfd8c1;

  /* Surface */
  --px-surface: #fff9e8;
  --px-surface-2: #f4efd9;
  --px-surface-3: #e4ecd9;

  /* Ink */
  --px-ink: #263247;
  --px-ink-muted: #697386;
  --px-ink-soft: #9299a5;
  --px-inverse: #fff9e8;

  /* Structural */
  --px-border: #263247;
  --px-border-soft: #9a947f;
  --px-shadow: #b9af93;

  /* Brand */
  --px-primary: #5279a8;
  --px-primary-light: #86add0;
  --px-primary-dark: #385777;

  /* Semantic */
  --px-success: #5d9564;
  --px-success-light: #dcebd8;

  --px-warning: #d39a3a;
  --px-warning-light: #f6e4b6;

  --px-danger: #bd5c58;
  --px-danger-light: #f1d6d1;

  --px-info: #5f88b7;
  --px-info-light: #d8e7f2;

  /* Decorative */
  --px-violet: #8b78a8;
  --px-coral: #c97861;
  --px-mint: #71a993;
  --px-yellow: #ddb653;
}
```

---

## 4.2 使用规则

背景：

```text
页面底色      --px-bg
主面板        --px-surface
次级面板      --px-surface-2
成功/自然区域 --px-surface-3
```

主文字必须优先使用：

```text
--px-ink
```

不要使用纯黑：

```css
/* Avoid */
color: #000;
```

像素风使用深蓝灰比纯黑更柔和。

---

## 4.3 App Accent

每个 App 可以有自己的 accent，但不能自建整套颜色体系。

建议：

```text
Core / Dashboard  Blue
Tasks             Mint
Assets            Amber
Mini Game         Violet
Settings          Slate
```

示例：

```css
[data-app="tasks"] {
  --app-accent: var(--px-mint);
}

[data-app="assets"] {
  --app-accent: var(--px-yellow);
}

[data-app="mini_game"] {
  --app-accent: var(--px-violet);
}
```

---

# 5. Typography

## 5.1 字体策略

不建议全站只用像素字体。

中文长文本全部使用像素字体会显著降低可读性。

推荐双字体系统：

### Display / Pixel Font

用于：

- Logo；
- 页面标题；
- App 名称；
- 按钮；
- Badge；
- Widget 标题；
- 数据数字；
- 小型系统提示。

推荐：

```text
Fusion Pixel / 缝合像素字体
```

该字体支持泛 CJK，适合作为 PersonalPlatform 的像素标题字体。

建议 self-host，不依赖远程 CDN。

### Body Font

用于：

- 正文；
- 描述；
- 表单；
- 长列表；
- 文件名；
- 错误信息。

推荐保留系统字体：

```css
Inter,
ui-sans-serif,
system-ui,
-apple-system,
BlinkMacSystemFont,
"Segoe UI",
sans-serif
```

---

## 5.2 Font Token

```css
:root {
  --font-pixel:
    "Fusion Pixel",
    "Zpix",
    monospace;

  --font-ui:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}
```

---

## 5.3 字号

像素字体尽量使用稳定整数级别：

```css
--text-xs: 12px;
--text-sm: 14px;
--text-md: 16px;
--text-lg: 20px;
--text-xl: 24px;
--text-2xl: 32px;
```

推荐：

| 场景 | 字号 |
|---|---:|
| Badge | 12 |
| Button | 12 / 14 |
| Widget title | 14 |
| App title | 16 |
| Page title | 24 |
| Hero number | 24 / 32 |
| 正文 | 14 / 16 |

---

# 6. Pixel Geometry

## 6.1 基础单位

所有主要视觉尺寸围绕：

```text
4 px
```

建立。

Spacing：

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
```

---

## 6.2 Border

核心规则：

```css
--border-pixel: 2px solid var(--px-border);
```

普通结构元素：

```text
1px border
```

强调组件：

```text
2px border
```

主 Button / Window：

```text
2px border + pixel shadow
```

---

## 6.3 Pixel Shadow

不要使用当前这种柔和 SaaS 阴影：

```css
box-shadow: 0 8px 24px rgb(...);
```

改为离散像素阴影：

```css
box-shadow: 4px 4px 0 var(--px-shadow);
```

强调控件：

```css
box-shadow:
  2px 2px 0 var(--px-border),
  4px 4px 0 var(--px-shadow);
```

按下：

```css
transform: translate(2px, 2px);
box-shadow: 2px 2px 0 var(--px-shadow);
```

---

## 6.4 Radius

Pixel UI 不使用 SaaS 风格大圆角。

禁止：

```text
10px
12px
14px
999px
```

推荐：

```text
0px
2px
4px（极少数）
```

默认：

```css
--radius-pixel: 0;
```

Badge 也建议矩形而非药丸：

```text
[ ENABLED ]
[ ERROR ]
[ TODO ]
```

而不是圆润 capsule。

---

# 7. Background

建议增加极弱的像素网格，不影响正文。

```css
body {
  background-color: var(--px-bg);
  background-image:
    linear-gradient(
      to right,
      rgb(38 50 71 / 0.035) 1px,
      transparent 1px
    ),
    linear-gradient(
      to bottom,
      rgb(38 50 71 / 0.035) 1px,
      transparent 1px
    );
  background-size: 16px 16px;
}
```

要求：

- 网格透明度低于 5%；
- 不能影响文字识别；
- 内容面板保持不透明。

---

# 8. Shell 架构

这是本次 UI 改造最重要的部分。

当前顶栏同时容纳：

- Dashboard
- App Center
- Settings
- 所有 Enabled Apps

随着 App 数量增加，会逐渐失去扩展性。

推荐改为：

```text
┌─────────────────────────────────────────────┐
│                  TOP BAR                    │
├─────────────┬───────────────────────────────┤
│             │                               │
│   APP DOCK  │           CONTENT             │
│             │                               │
│             │                               │
└─────────────┴───────────────────────────────┘
```

---

# 9. Top Bar

桌面高度：

```text
56px
```

结构：

```text
[ Pixel Logo ] PersonalPlatform   [ Page Title ]    [ Status ]
```

可选后续功能：

```text
Search
Command Palette
Clock
Theme
Profile
```

第一版不要全部实现。

建议第一版：

```text
Logo + 当前页面名称 + Core 状态
```

---

## 9.1 Brand

不要仅显示：

```text
Personal Platform
```

建议：

```text
▣ PERSONAL PLATFORM
```

或者：

```text
[PP] PERSONAL PLATFORM
```

Logo 使用 16×16 或 24×24 像素图标。

---

# 10. App Dock

## Desktop >= 960px

宽度：

```text
208px
```

内容：

```text
CORE
  Dashboard
  App Center
  Settings

APPS
  Tasks
  Assets
  Mini Game
  ...
```

当前页面使用：

```text
▸ TASKS
```

或：

```text
[■] Tasks
```

Dock Item：

```text
height: 40px
icon: 16px
gap: 8px
```

---

## Tablet 600–959px

Dock 收窄为：

```text
64px
```

只显示图标。

hover / focus 显示 tooltip。

---

## Mobile < 600px

左 Dock 消失。

改为底部：

```text
Dashboard | Apps | More
```

App 进入 `More / Launcher`。

避免在 320px 宽屏幕塞入所有 App。

---

# 11. Page Layout

桌面：

```css
.page-container {
  width: min(1280px, calc(100vw - 260px));
  margin: 0 auto;
  padding: 32px;
}
```

推荐内容最大宽度：

```text
1200–1280px
```

数据密集页面可更宽。

表单详情页面建议：

```text
720–880px
```

---

# 12. Pixel Window

这是全系统最核心的组件。

所有 Dashboard widget、设置区块、主要 panel 都可使用。

结构：

```text
┌──────────────────────────────────┐
│ ■ TASKS TODAY                  _ │
├──────────────────────────────────┤
│                                  │
│           CONTENT                │
│                                  │
└──────────────────────────────────┘
    ░░░ pixel shadow
```

React API：

```tsx
<PixelWindow
  title="Tasks Today"
  icon="check"
  accent="tasks"
>
  ...
</PixelWindow>
```

建议 DOM：

```tsx
<section className="px-window">
  <header className="px-window__header">
    <PixelIcon />
    <h2>Tasks Today</h2>
  </header>

  <div className="px-window__body">
    ...
  </div>
</section>
```

---

# 13. Pixel Button

Variants：

```text
primary
secondary
danger
ghost
icon
```

默认：

```css
.px-button {
  min-height: 36px;
  padding: 8px 12px;
  border: 2px solid var(--px-border);
  border-radius: 0;
  font-family: var(--font-pixel);
  background: var(--px-primary);
  color: var(--px-inverse);
  box-shadow: 3px 3px 0 var(--px-border);
}
```

Hover：

```text
颜色略亮
```

Active：

```text
向右下移动 2px
阴影缩小
```

Focus：

```css
outline: 2px solid var(--px-warning);
outline-offset: 3px;
```

Disabled：

- 不允许只靠 opacity；
- 使用 muted fill；
- cursor not-allowed；
- 保持文字可读。

---

# 14. Inputs

Input 不应做成游戏输入框，而是现代可用的方形 pixel field。

```css
.px-input {
  min-height: 40px;
  border: 2px solid var(--px-border);
  background: var(--px-surface);
  padding: 8px 10px;
  color: var(--px-ink);
}
```

Focus：

```css
box-shadow: inset 0 -3px 0 var(--px-primary-light);
```

Placeholder 使用：

```text
--px-ink-soft
```

Search Input 可增加：

```text
[?] SEARCH ITEMS...
```

视觉 icon，不改变实际 placeholder 语义。

---

# 15. Checkbox

保留原生 input 语义。

视觉做成 16×16 pixel checkbox：

```text
[ ]
[x]
```

Done：

```text
绿色 fill + 深色 border
```

不要完全移除原生可访问性。

---

# 16. Badge / Status

统一状态：

```text
[ ENABLED ]
[ DISABLED ]
[ ERROR ]
[ INSTALLED ]
[ TODO ]
[ DONE ]
[ OVERDUE ]
```

建议：

```css
.px-badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 2px 6px;
  border: 1px solid currentColor;
  border-radius: 0;
  font-family: var(--font-pixel);
  font-size: 12px;
}
```

---

# 17. Icon System

第一版不建议引入大型 icon library。

原因：

- 当前依赖非常轻；
- 普通 outline icon 与像素 UI 风格不统一；
- 16×16 pixel icons 数量暂时很少。

建议建立：

```text
frontend/src/shared/ui/icons/
```

每个图标：

```text
16×16 SVG
```

规则：

- 坐标必须落在整数；
- 主要线条 2px；
- 避免圆弧；
- 避免渐变；
- 使用 `shape-rendering="crispEdges"`；
- 默认 `currentColor`。

第一批图标：

```text
home
apps
settings
check
box
gamepad
search
plus
trash
arrow-left
file
folder
warning
refresh
```

后续再扩展。

---

# 18. Dashboard

Dashboard 应成为 Pixel OS 最有辨识度的页面。

当前普通 grid：

```text
Card
Card
Card
```

改为：

```text
SYSTEM OVERVIEW

┌ TASKS TODAY ───────┐  ┌ INVENTORY ─────────┐
│ 03 TODAY           │  │ 128 ITEMS           │
│ 01 OVERDUE         │  │  12 CATEGORIES      │
└────────────────────┘  └─────────────────────┘

┌ MINI GAME ────────────────────────────────┐
│ HIGH SCORE 2048                           │
└───────────────────────────────────────────┘
```

---

## 18.1 Grid

```css
.dashboard-grid {
  display: grid;
  grid-template-columns:
    repeat(12, minmax(0, 1fr));
  gap: 16px;
}
```

默认 widget：

```text
desktop 6 columns
large   12 columns
small   4 columns
```

如果暂时不增加 widget size metadata：

```css
grid-template-columns:
  repeat(auto-fit, minmax(280px, 1fr));
```

也可以保持现有逻辑。

---

## 18.2 Widget 数据展示

不要：

```text
3 due today · 1 overdue · 17 done
```

建议：

```text
TODAY      OVERDUE       DONE
  03          01          17
```

Pixel UI 对数据 dashboard 的展示尤其适合数字分块。

---

# 19. Dashboard Widget 状态

Loading：

```text
[•••] LOADING DATA
```

Error：

```text
┌ ! WIDGET ERROR ─────┐
│ Unable to load data │
│ [ RETRY ]           │
└─────────────────────┘
```

Empty：

```text
NO DATA YET
[ OPEN APP ]
```

不要只显示一行灰色文本。

---

# 20. App Center

当前 App Center 使用纵向普通 list。

推荐改为 App Library Grid。

```text
APP LIBRARY

┌────────────────┐ ┌────────────────┐
│    [TASK]      │ │    [BOX]       │
│                │ │                │
│ Tasks          │ │ Assets         │
│ v1.0           │ │ v1.0           │
│ [ ENABLED ]    │ │ [ ENABLED ]    │
│                │ │                │
│ [ DISABLE ]    │ │ [ DISABLE ]    │
└────────────────┘ └────────────────┘
```

Desktop：

```text
3–4 columns
```

Tablet：

```text
2 columns
```

Mobile：

```text
1 column
```

---

## 20.1 App Card

内容：

1. Icon
2. Name
3. 简短 description
4. Version
5. Status
6. Enable / Disable

未来 `AppInfo` 可增加：

```ts
description?: string;
icon?: string;
color?: string;
```

但第一阶段不强制修改后端 schema。

可以先在 frontend module metadata 内定义 icon。

---

# 21. Tasks App

定位：

```text
Quest Log 风格的生产力任务页面
```

但不要真的把所有文案改成 RPG。

保留：

```text
Tasks
Todo
Done
Due
```

视觉上使用 Quest Log。

---

## 21.1 页面结构

```text
TASKS

┌ NEW TASK ─────────────────────────────────┐
│ [ New task........................ ] [ + ] │
└───────────────────────────────────────────┘

[ ALL ] [ TODO ] [ DONE ]

TODAY
┌───────────────────────────────────────────┐
│ [ ] Finish document            TODAY      │
├───────────────────────────────────────────┤
│ [x] Backup files               DONE       │
└───────────────────────────────────────────┘
```

---

## 21.2 Task Row

当前：

```text
checkbox title due delete
```

改为：

```text
checkbox
title
due badge
overflow action
```

Delete 不建议每一行都显示巨大主按钮。

推荐：

```text
[ ⋯ ]
```

或小型 trash icon。

Desktop hover 后出现。

Mobile 保持可点击。

---

## 21.3 Completed

禁止仅仅：

```text
opacity: 0.5
```

使用：

- checkbox filled；
- title strike-through；
- muted ink；
- DONE badge；
- 保持可读。

---

# 22. Assets App

Assets 很适合 pixel inventory 隐喻。

页面名称仍然：

```text
Assets
```

但视觉参考 RPG Inventory。

---

## 22.1 页面结构

```text
ASSETS

┌ ADD ITEM ────────────────┐
│ [ Item name ] [ + ADD ]  │
└──────────────────────────┘

[ Search inventory................ ]

CATEGORIES
[ ALL ] [ HARDWARE ] [ BOOKS ] [...]

INVENTORY
┌─────────────┐ ┌─────────────┐
│     □       │ │     □       │
│ Mac mini    │ │ Microphone  │
│ ×1          │ │ ×2          │
└─────────────┘ └─────────────┘
```

---

## 22.2 Inventory Card

即使目前没有图片，也应预留图片区：

```text
64×64
```

没有附件时显示：

```text
pixel box placeholder
```

未来附件中存在图片，可作为缩略图。

图片：

```css
image-rendering: pixelated;
```

只应对真正像素图使用。

普通照片不要强制 pixelated。

---

## 22.3 Categories

当前普通 `<ul>` 改为：

```text
filter chips / rectangular tabs
```

例如：

```text
[ ALL 32 ]
[ COMPUTER 8 ]
[ AUDIO 4 ]
```

---

# 23. Asset Detail

建议使用 Info Window。

```text
← ASSETS

┌ ITEM: MAC MINI ───────────────────────────┐
│                                          │
│  [ IMAGE ]       Quantity     1           │
│                  Category     Computer    │
│                  Acquired     2026-...    │
│                                          │
├ ATTACHMENTS ──────────────────────────────┤
│ README.pdf                1.2 MB          │
│ photo.jpg                 860 KB          │
│                                          │
│ [ + UPLOAD FILE ]                         │
└──────────────────────────────────────────┘
```

---

# 24. Mini Game

Mini Game 应成为整个视觉系统的原生验证页面。

当前 2048 board 已经比较适合像素化。

建议：

- 去掉圆角；
- Tile 使用 2px border；
- Board 使用 4px outer border；
- Tile 阴影使用硬阴影；
- Score 使用 pixel font；
- Restart 使用 PixelButton；
- 键盘提示放在 footer。

示例：

```text
MINI GAME / 2048

SCORE  1024      BEST  8192

┌────┬────┬────┬────┐
│  2 │    │  4 │  8 │
├────┼────┼────┼────┤
│    │ 16 │ 32 │    │
...
└────┴────┴────┴────┘

ARROW KEYS TO MOVE
[ NEW GAME ]
```

不要加入：

- CRT distortion；
- screen flicker；
- 复杂 canvas shader。

---

# 25. Settings

Settings 应采用 System Panel 风格。

```text
SYSTEM SETTINGS

┌ APPEARANCE ───────────────────────────────┐
│ Theme              Light                  │
│ Pixel Effects      Normal                 │
└───────────────────────────────────────────┘

┌ SYSTEM ───────────────────────────────────┐
│ API status           ONLINE               │
│ Frontend version     0.0.0                │
└───────────────────────────────────────────┘
```

未来可增加：

```text
Theme
Font
Animation
Dashboard layout
Compact mode
```

---

# 26. Empty State

统一使用：

```text
Pixel Icon
Title
Short Explanation
Primary Action
```

例如 Assets：

```text
        [ BOX ]

YOUR INVENTORY IS EMPTY

Add the first item to start tracking
your personal assets.

[ + ADD ITEM ]
```

不要只有：

```text
No items.
```

---

# 27. Loading State

第一版不要做复杂 skeleton framework。

统一：

```text
[■□□] LOADING
[■■□] LOADING
[■■■] LOADING
```

可以使用 3-frame CSS animation。

必须支持：

```css
@media (prefers-reduced-motion: reduce)
```

禁用动画。

---

# 28. Toast / Feedback

建议新增统一 toast。

位置：

```text
desktop: bottom-right
mobile: bottom-center
```

状态：

```text
SUCCESS
ERROR
INFO
```

示例：

```text
┌ ✓ SAVED ──────────────┐
│ Dashboard updated.    │
└───────────────────────┘
```

不要依赖 alert()。

---

# 29. Motion

像素 UI 动画应短促。

推荐：

```text
80–160ms
```

允许：

- button press；
- panel appear；
- nav active；
- toast；
- checkbox；
- loading dots。

避免：

- 500ms 页面飞入；
- bounce；
- continuous floating；
- 大面积 parallax。

---

# 30. Responsive Rules

## >= 1200px

```text
Dock: 208px
Content: max 1280px
Dashboard: 3–4 widget columns
```

## 960–1199px

```text
Dock: 192px
Dashboard: 2–3 columns
```

## 600–959px

```text
Dock: 64px icon mode
Dashboard: 2 columns
```

## < 600px

```text
No side dock
Bottom navigation
Single-column content
Page padding: 16px
```

---

# 31. Mobile Controls

所有交互元素目标触摸区域至少：

```text
40×40px
```

优先：

```text
44×44px
```

Pixel icon 本身可以只有：

```text
16×16px
```

但外部 button hit-area 必须足够大。

---

# 32. Accessibility

像素风不能牺牲可访问性。

必须满足：

1. 所有 action 都可键盘访问；
2. focus ring 清晰；
3. body text contrast >= 4.5:1；
4. 状态不能仅靠颜色表示；
5. error 同时有 icon / text；
6. checkbox 保留 semantic input；
7. button 保留 `<button>`；
8. navigation 使用 `<nav>`；
9. heading 层级正确；
10. 支持 `prefers-reduced-motion`；
11. 200% zoom 时页面仍可使用；
12. 320px 宽度不产生全局横向滚动。

---

# 33. CSS Architecture

当前 `styles.css` 已开始变得过于集中。

推荐拆分为：

```text
frontend/src/styles/
├── tokens.css
├── reset.css
├── base.css
├── layout.css
├── components.css
└── utilities.css
```

如果希望更明确：

```text
frontend/src/styles/
├── tokens.css
├── base.css
├── shell.css
├── forms.css
├── pixel-window.css
├── pixel-button.css
├── states.css
└── apps.css
```

第一阶段建议不要拆太细。

推荐：

```text
tokens.css
base.css
components.css
shell.css
apps.css
```

然后：

```css
/* styles.css */

@import "./styles/tokens.css";
@import "./styles/base.css";
@import "./styles/components.css";
@import "./styles/shell.css";
@import "./styles/apps.css";
```

---

# 34. React UI Components

新增：

```text
frontend/src/shared/ui/
├── PixelBadge.tsx
├── PixelButton.tsx
├── PixelIcon.tsx
├── PixelInput.tsx
├── PixelWindow.tsx
├── EmptyState.tsx
├── LoadingState.tsx
└── StatusMessage.tsx
```

不要第一轮就构建 30 个组件。

优先抽象重复视觉 primitives。

---

# 35. 推荐 Component API

## PixelButton

```tsx
<PixelButton variant="primary">
  Add item
</PixelButton>
```

```ts
type PixelButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost";
```

---

## PixelBadge

```tsx
<PixelBadge tone="success">
  Enabled
</PixelBadge>
```

---

## PixelWindow

```tsx
<PixelWindow
  title="Asset Summary"
  icon="box"
>
  ...
</PixelWindow>
```

---

## EmptyState

```tsx
<EmptyState
  icon="box"
  title="No assets yet"
  description="Add your first item."
  action={...}
/>
```

---

# 36. Design Token 示例

建议第一轮直接建立以下 CSS。

```css
:root {
  --px-bg: #ebe5d1;
  --px-surface: #fff9e8;
  --px-surface-2: #f4efd9;

  --px-ink: #263247;
  --px-ink-muted: #697386;

  --px-border: #263247;
  --px-shadow: #b9af93;

  --px-primary: #5279a8;
  --px-primary-light: #86add0;

  --px-success: #5d9564;
  --px-warning: #d39a3a;
  --px-danger: #bd5c58;

  --font-pixel: "Fusion Pixel", monospace;
  --font-ui: Inter, ui-sans-serif, system-ui, sans-serif;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  --border-1: 1px;
  --border-2: 2px;

  --shadow-pixel:
    4px 4px 0 var(--px-shadow);

  --shadow-pixel-strong:
    2px 2px 0 var(--px-border),
    4px 4px 0 var(--px-shadow);
}
```

---

# 37. Button CSS 示例

```css
.px-button {
  appearance: none;
  min-height: 40px;
  padding: 8px 14px;

  border: 2px solid var(--px-border);
  border-radius: 0;

  background: var(--px-primary);
  color: var(--px-surface);

  font-family: var(--font-pixel);
  font-size: 12px;

  box-shadow: 3px 3px 0 var(--px-border);

  cursor: pointer;

  transition:
    transform 80ms steps(1),
    box-shadow 80ms steps(1),
    background-color 80ms linear;
}

.px-button:hover {
  background: var(--px-primary-light);
  color: var(--px-ink);
}

.px-button:active {
  transform: translate(2px, 2px);
  box-shadow: 1px 1px 0 var(--px-border);
}

.px-button:focus-visible {
  outline: 2px solid var(--px-warning);
  outline-offset: 3px;
}

.px-button:disabled {
  background: var(--px-surface-2);
  color: var(--px-ink-muted);
  cursor: not-allowed;
  box-shadow: none;
}
```

---

# 38. Window CSS 示例

```css
.px-window {
  border: 2px solid var(--px-border);
  background: var(--px-surface);
  box-shadow: var(--shadow-pixel);
}

.px-window__header {
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;

  padding: 8px 10px;

  border-bottom: 2px solid var(--px-border);
  background: var(--px-surface-2);
}

.px-window__title {
  margin: 0;
  font-family: var(--font-pixel);
  font-size: 14px;
  line-height: 1;
}

.px-window__body {
  padding: 16px;
}
```

---

# 39. Icon CSS

```css
.px-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;

  shape-rendering: crispEdges;
}
```

Raster pixel asset：

```css
.pixel-art {
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
```

普通照片不要加 `.pixel-art`。

---

# 40. 页面标题

推荐格式：

```text
TASKS
Personal task manager
```

视觉：

```css
.page-header__title {
  font-family: var(--font-pixel);
  font-size: 24px;
  text-transform: uppercase;
}
```

英文可 uppercase。

中文标题不需要强行英文大写风格。

---

# 41. 文案风格

整个系统文案建议：

- 简洁；
- 系统化；
- 不卖萌；
- 不过度 RPG；
- 不把真实功能名改成游戏名。

推荐：

```text
Tasks
Assets
App Center
Settings
Dashboard
```

可在辅助文字中带一点像素 OS 味道：

```text
3 apps active
System ready
No widgets installed
```

避免：

```text
勇者任务大厅
神奇背包
魔法设置
```

除非以后专门加入 Theme Pack。

---

# 42. Dark Mode

第一版不建议同时开发完整 dark mode。

原因：

- 会使 token、对比度与 app-specific accent 工作量翻倍；
- 当前首要目标是建立稳定 UI system。

但所有颜色都必须通过 token。

禁止在 App 中散落：

```css
background: #ffffff;
color: #333333;
```

这样第二阶段增加 dark theme 时只需要覆盖 tokens。

---

# 43. 不建议第一阶段引入的技术

不建议为了此次改造引入：

```text
Tailwind
shadcn/ui
Material UI
Ant Design
Chakra
Bootstrap
styled-components
Emotion
大型 icon pack
Framer Motion
```

原因不是这些工具不好，而是当前项目规模和现有依赖下没有必要。

首轮：

```text
React + CSS + SVG
```

完全足够。

以后组件数量达到明显维护压力后再评估。

---

# 44. 前端文件调整建议

建议：

```text
frontend/src/
├── apps/
│   ├── assets/
│   ├── mini_game/
│   └── tasks/
│
├── shared/
│   ├── ui/
│   │   ├── PixelBadge.tsx
│   │   ├── PixelButton.tsx
│   │   ├── PixelIcon.tsx
│   │   ├── PixelWindow.tsx
│   │   ├── EmptyState.tsx
│   │   └── LoadingState.tsx
│   └── ...
│
├── shell/
│   ├── App.tsx
│   ├── AppDock.tsx
│   ├── TopBar.tsx
│   ├── AppCenter.tsx
│   ├── Dashboard.tsx
│   └── ...
│
├── styles/
│   ├── tokens.css
│   ├── base.css
│   ├── components.css
│   ├── shell.css
│   └── apps.css
│
├── main.tsx
└── styles.css
```

原 `Nav.tsx` 最终可以被：

```text
TopBar.tsx
AppDock.tsx
MobileNav.tsx
```

替代。

---

# 45. Shell React 结构建议

最终大致：

```tsx
<BrowserRouter>
  <div className="shell">
    <TopBar />

    <div className="shell__workspace">
      <AppDock apps={enabledApps} />

      <main className="shell__content">
        <Routes>
          ...
        </Routes>
      </main>
    </div>

    <MobileNav />
  </div>
</BrowserRouter>
```

不要修改：

```text
enabledAppModules
resolveRoutes
resolveWidgets
```

这类核心模块发现逻辑。

---

# 46. Dashboard 改造范围

现有 Dashboard 业务逻辑应保持：

```text
layout loading
widget resolution
hidden widgets
persist layout
ErrorBoundary
```

仅替换：

```text
page layout
widget markup
loading
error
restore button
visual styles
```

不要把 UI 改造变成 dashboard lifecycle 重写。

---

# 47. App Center 改造范围

保留：

```text
setAppEnabled()
busy state
error state
onChanged()
```

改造：

```text
ul/list -> responsive app grid
status -> PixelBadge
button -> PixelButton
error -> StatusMessage
```

---

# 48. Tasks 改造范围

保留：

```text
createTask
setStatus
remove
statusFilter
useAsync
API route
```

改造：

```text
form layout
filter control
task row
checkbox
delete affordance
loading/error/empty states
```

---

# 49. Assets 改造范围

保留：

```text
createItem
createCategory
search
attachments
upload
summary
API
```

改造：

```text
inventory grid
category filter visual
search bar
detail window
attachment list
empty states
```

注意：

目前 category list 与 item category assignment 能力仍比较基础。

此次 UI 改造不必顺带扩展业务功能。

---

# 50. Mini Game 改造范围

业务规则完全不动。

仅处理：

```text
board border
tiles
score display
button
spacing
typography
responsive scaling
```

---

# 51. 实施阶段

建议分 5 个批次。

---

## Phase UI-0 — Design Foundation

目标：

```text
建立 token 与 pixel primitive 基础
```

修改：

```text
styles.css
styles/tokens.css
styles/base.css
shared/ui/*
```

完成：

- color tokens；
- typography；
- spacing；
- PixelButton；
- PixelBadge；
- PixelWindow；
- PixelIcon；
- focus states。

验收：

```text
npm run check
npm test
npm run build
```

必须全部通过。

---

## Phase UI-1 — Shell

目标：

```text
把普通顶部导航变成 Pixel Personal OS Shell
```

实现：

- TopBar；
- AppDock；
- MobileNav；
- responsive layout；
- active route state。

不要改业务 route。

---

## Phase UI-2 — Dashboard + App Center

Dashboard：

- Pixel windows；
- summary number layout；
- standardized loading/error；
- responsive widget grid。

App Center：

- card grid；
- icons；
- status badge；
- enable/disable buttons。

这一阶段完成后，整个系统应该已经具有明确统一像素风。

---

## Phase UI-3 — Tasks + Assets

Tasks：

- Quest Log visual；
- compact task row；
- filters；
- empty state。

Assets：

- Inventory grid；
- category chips；
- item detail window；
- attachment panel。

---

## Phase UI-4 — Mini Game + Settings + Polish

完成：

- Mini Game；
- Settings；
- Not Found；
- backend unavailable；
- loading screen；
- toast；
- mobile polish；
- reduced motion；
- visual consistency。

---

# 52. 每阶段工程约束

每一阶段必须：

```text
不修改 API contract
不修改数据库
不修改 backend business logic
不破坏 module discovery
不破坏 route registration
不删除现有 tests
```

如果需要改测试，只允许：

```text
因 DOM / class / accessible name 合理变化而更新
```

不能通过弱化测试来让 UI 修改通过。

---

# 53. Visual Regression 建议

项目已有 Playwright。

建议添加：

```text
frontend/e2e/visual.spec.ts
```

覆盖：

```text
Dashboard desktop
App Center desktop
Tasks desktop
Assets desktop
Dashboard mobile
App Center mobile
```

初期无需非常严格的全页面像素 diff。

至少保证：

- 页面可访问；
- 无横向溢出；
- 核心组件存在；
- mobile nav 正常。

---

# 54. Browser QA

至少：

```text
Chromium
WebKit
```

重点测试：

- Pixel font fallback；
- CSS grid；
- image-rendering；
- focus outline；
- sticky dock；
- mobile bottom nav。

---

# 55. Performance

像素 UI 本身应极轻。

第一版原则：

- 不加载大型背景图；
- 不使用 Canvas 作为整个 Shell；
- 不用 WebGL；
- 不用视频背景；
- SVG icon；
- CSS pattern；
- self-host 单个或少量 font weight。

字体建议 preload：

```html
<link
  rel="preload"
  href="/fonts/fusion-pixel.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>
```

仅在实际提供对应 woff2 文件后添加。

---

# 56. Pixel Font 注意事项

如果使用 Fusion Pixel / 其他开源中文像素字体：

1. 固定一个版本；
2. 将 license 一并保存在仓库；
3. 使用 woff2；
4. 不把完整开发字体包全部塞进 frontend；
5. 明确 fallback；
6. 中文正文仍优先 UI font。

建议：

```text
public/fonts/
├── fusion-pixel-12px.woff2
└── LICENSE.txt
```

---

# 57. 设计资产目录

建议：

```text
frontend/public/pixel/
├── app-icons/
│   ├── tasks.svg
│   ├── assets.svg
│   └── mini-game.svg
├── system/
│   └── logo.svg
└── decorations/
```

不要在第一阶段加入大量装饰图。

---

# 58. Logo 方向

推荐 PersonalPlatform Logo：

```text
16×16 / 24×24
```

概念可以是：

```text
四个小方块组成的窗口
盒子 + 光标
PP 字母像素 monogram
小型 desktop icon
```

不要做复杂 illustration。

Logo 必须在：

```text
16px
24px
32px
```

仍可辨认。

---

# 59. 视觉优先级

实现时依次保证：

```text
1. Layout
2. Typography
3. Border / Shadow
4. Color
5. Component Consistency
6. Icon
7. Animation
8. Decoration
```

不要先画大量 pixel art，再回头修布局。

---

# 60. 第一版完成后的视觉目标

打开 PersonalPlatform 后应立即感受到：

```text
这是一个“个人操作系统”，
不是一组普通 CRUD 页面。
```

但使用 10 分钟后，用户应该感受到：

```text
它仍然是一个清晰、高效、正常的生产力工具。
```

这是本设计最重要的平衡。

---

# 61. Definition of Done

像素风前端 v1 完成必须满足以下条件。

## Design

- [ ] 全站使用统一 color token；
- [ ] 全站使用统一 spacing token；
- [ ] 不存在 SaaS 风大圆角 card；
- [ ] 主面板采用 pixel border + hard shadow；
- [ ] 标题 / badge / button 形成统一像素语言；
- [ ] 正文保持高可读性。

## Shell

- [ ] Desktop 使用可扩展 App Dock；
- [ ] Tablet Dock 可收窄；
- [ ] Mobile 不显示拥挤的完整 App 导航；
- [ ] 当前 route 状态清晰；
- [ ] App 数量增加时导航不会崩坏。

## Dashboard

- [ ] Widget 使用统一 PixelWindow；
- [ ] Loading / Error / Empty 状态统一；
- [ ] 320px 不横向溢出；
- [ ] Widget 数据不再只是普通文本段落。

## App Center

- [ ] App 使用 card grid；
- [ ] status 统一；
- [ ] enable/disable 视觉清晰；
- [ ] busy/disabled/error 状态清晰。

## Tasks

- [ ] Task list 可快速浏览；
- [ ] checkbox 可访问；
- [ ] done 状态清晰；
- [ ] delete 不抢夺主视觉层级；
- [ ] mobile 可操作。

## Assets

- [ ] 使用 inventory grid；
- [ ] 分类和搜索层级清楚；
- [ ] detail page 有统一信息面板；
- [ ] attachment 区域清晰。

## Mini Game

- [ ] 与平台视觉统一；
- [ ] board 不使用 SaaS 圆角；
- [ ] score/button/type 使用统一 token；
- [ ] 手机端可显示。

## Quality

- [ ] `npm run check` PASS；
- [ ] `npm test` PASS；
- [ ] `npm run build` PASS；
- [ ] Playwright 核心页面 PASS；
- [ ] keyboard navigation 可用；
- [ ] `prefers-reduced-motion` 有效；
- [ ] 200% zoom 可用；
- [ ] 320px viewport 无全局横向滚动。

---

# 62. 推荐最终效果关键词

如果之后需要让设计模型、图像模型或前端 Agent 理解目标，可以使用以下统一描述：

```text
A cozy 16-bit pixel personal operating system UI,
warm light background,
dark navy pixel borders,
hard 4px shadows,
compact pixel icons,
retro utility windows,
modern readable body typography,
modular dashboard widgets,
inventory-style asset manager,
quest-log task manager,
minimal animation,
clean responsive layout,
not cyberpunk,
not CRT,
not overly game-like.
```

中文：

```text
温和明亮的 16-bit 像素个人操作系统界面，
深蓝灰像素边框、4px 硬阴影、方形控件、
模块化桌面 Widget、像素应用 Dock，
物品管理采用 Inventory 视觉，
任务管理采用 Quest Log 视觉，
正文保持现代 UI 字体和高可读性，
不过度游戏化，不使用赛博朋克或 CRT 风格。
```

---

# 63. 推荐实施结论

PersonalPlatform 当前结构非常适合建立统一 UI system。

本轮不建议对架构进行大改。

最合理的施工顺序是：

```text
Design Tokens
      ↓
Shared Pixel Components
      ↓
Shell / App Dock
      ↓
Dashboard
      ↓
App Center
      ↓
Tasks / Assets
      ↓
Mini Game / Settings
      ↓
Responsive + Accessibility + Polish
```

其中最重要的两项是：

```text
1. 建立统一 Pixel UI primitives
2. 将顶部横向 Nav 改造成可扩展的 App Dock
```

只要这两部分稳定，未来新增：

```text
Health
Notes
Finance
Bookmarks
Habits
Media
Home Automation
Research Tools
更多小游戏
```

都可以直接继承 Pixel Personal OS 视觉，而不需要重新设计整套界面。

---

## Appendix A — 推荐首批组件

```text
PixelButton
PixelBadge
PixelWindow
PixelIcon
PixelInput
EmptyState
LoadingState
StatusMessage
```

不要超过这一批。

---

## Appendix B — 推荐首批图标

```text
dashboard
apps
settings
tasks
assets
game
search
plus
delete
back
warning
refresh
file
folder
check
```

---

## Appendix C — UI v1 非目标

明确不做：

```text
完整 Dark Mode
拖拽 Dashboard
窗口自由移动
桌面图标自由排列
复杂 Theme Marketplace
CRT Filter
Pixel Particle System
大型 UI Framework 迁移
业务 API 重构
数据库修改
App Plugin 架构重写
```

这些都可以在 Pixel UI v1 稳定后单独评估。

---

**最终设计原则：**

> **让 PersonalPlatform 看起来像一个像素世界里的个人操作系统，但用起来仍然像一个成熟、清晰、可靠的现代 Web 应用。**
