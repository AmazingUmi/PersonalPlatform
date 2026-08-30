# Phase 7A-1 — Notes App（施工前定稿 WORKLIST）

Scope Summary：新增第 5 个 App `notes`（Notes，route `/notes`）——低摩擦个人记录（capture first, organize later）。
一个垂直切片：`apps/notes/`（manifest + 首个 migration）+ `backend/src/apps/notes/`（notes/tags CRUD、搜索过滤、
平台时区日期分组）+ `frontend/src/apps/notes/`（timeline 主页、全字段编辑器、Quick Note dashboard widget）+ 测试
（backend unit/integration、frontend component、独立 e2e spec）。App Contract V1 不变，platformApiVersion=1，
**不改 Platform Core**；契约强制的共享改动仅测试基建 `backend/test/helpers/db.ts` 的 `APP_SCHEMAS`（Contract V1
checklist 明确要求），另有文档认可的 optional wiring 3 处（§3.7）。读者假定已读 `doc/APP_DEVELOPMENT.md`。

---

## 1. 数据模型（定稿）

`apps/notes/migrations/<ts>-init.sql`（bare table names，runner 建 schema `notes`）：

```sql
CREATE TABLE notes (
  id uuid PRIMARY KEY,
  title text,
  content text NOT NULL,
  mood text CHECK (mood IN ('great', 'good', 'neutral', 'low', 'bad')),
  occurred_at timestamptz NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE note_tags (
  note_id uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (note_id, tag_id)
);

CREATE INDEX notes_occurred_at_idx ON notes(occurred_at DESC, created_at DESC);
CREATE INDEX notes_pinned_idx ON notes(pinned) WHERE pinned;
CREATE INDEX note_tags_tag_idx ON note_tags(tag_id);
```

拍板与理由：

- **occurred_at 无 DB default**。默认值语义是"ctx.time.now()"（平台时钟），必须由 handler 在应用层注入，
  DB `now()` 用的是数据库时钟且绕过 TimeService。created_at/updated_at 用 DB default 无妨（纯系统列）。
- **mood 用 text + CHECK，不用 pg enum**。校验错误码：JSON Schema `enum` 在 boundary 拒绝 → `400 validation_error`
  （与其他 enum 字段同路径，无独立 code）；CHECK 约束仅作 defense-in-depth。理由：本仓库迁移 forward-only，
  未来增删 mood 值时 text+CHECK 是一条普通 ALTER TABLE，pg enum 的 ALTER TYPE 在迁移工具里更笨重；且 enum 的
  23505/23514 错误映射不如 schema 校验信息友好。
- **删除 tag 不删 note**：`note_tags.tag_id … ON DELETE CASCADE`（P7A1-03）；删除 note 级联清理关联
  （`note_id … ON DELETE CASCADE`）。孤儿 tag（无 note 引用）保留，由用户显式 DELETE /tags/:id。
- title nullable、content NOT NULL，P7A1-02 原样落地；created_at 永不出现在任何 request schema
  （`additionalProperties: false` 兜底）。

## 2. API（定稿）

Routes（全部在 `/api/apps/notes` 下，lifecycle guard 之后）：

| Method | Path | 说明 |
|---|---|---|
| GET | `/notes` | 列表 + 过滤/搜索/排序（见下） |
| POST | `/notes` | 创建；Quick Note 复用此路由，body 只给 `{ content }` |
| GET | `/notes/:id` | 单条（含 tags、dayKey） |
| PATCH | `/notes/:id` | 三态部分更新（含 tagIds 整体替换） |
| DELETE | `/notes/:id` | 204；级联清 note_tags |
| GET | `/tags` | `{ items }`，ORDER BY name |
| POST | `/tags` | **get-or-create 幂等 upsert**（见 D4） |
| DELETE | `/tags/:id` | 204；级联解关联，note 保留 |

### 2.1 Response shape（camelCase，view boundary）

```
NoteView = {
  id, title: string|null, content: string,
  mood: "great"|"good"|"neutral"|"low"|null,
  occurredAt: ISO-UTC, pinned: boolean, createdAt: ISO-UTC, updatedAt: ISO-UTC,
  tags: { id, name }[],        // 内嵌 id+name：timeline 直接渲染 chip，编辑器直接回填 ids
  dayKey: "YYYY-MM-DD"         // occurred_at 在平台时区下的本地日期，服务端算
}
```

- snake_case→camelCase 转换在 `toNoteView(row)`（mini_game `toSave` 先例；**不要学 assets 的 snake_case 直出**）。
- 列表响应：`{ items: NoteView[], total, todayKey, yesterdayKey }`。`todayKey`/`yesterdayKey` 由服务端按
  `ctx.time` 计算（见 §2.4），前端因此**完全不做时区运算**。

### 2.2 校验（JSON Schema，全部写接口 + 列表 querystring）

- POST /notes body：`{ content: string 1..100_000 (required), title?: string ≤300 | null,
  mood?: enum | null, occurredAt?: date-time | null, pinned?: boolean, tagIds?: string[] }`。
  缺省默认：title=null、mood=null、occurredAt=ctx.time.now()、pinned=false、tagIds=[]（P7A1-02/09）。
- PATCH /notes body：同字段全可选，**三态**：absent=保持、`null`=清空（title/mood/occurredAt）、值=更新。
  `tagIds` 例外：absent=保持关联不变；给数组=**整体替换**集合（[] 即清空全部）；`tagIds: null` → 400
  validation_error（用 [] 表达清空，语义无歧义）。
- POST /tags body：`{ name: string 1..50 }`，handler 内 `trim()`；UNIQUE 精确匹配（不 lower-case，与 assets
  categories 一致）。

### 2.3 Tags 语义（D4/D5 拍板）

- **POST /tags = get-or-create**：`INSERT … ON CONFLICT (name) DO NOTHING RETURNING …`，无返回行则再 SELECT
  已有行。新建返回 201，已存在返回 200，body 同一 shape。理由：编辑器"输入新名字即创建"一步到位，无
  422→先查→重试的竞态窗口；幂等便于重试。
- **note 的 tagIds 校验**：请求内重复 id **静默去重**（`new Set`）；不存在的 tag id 靠 `note_tags.tag_id` FK
  触发 23503 → 手工映射 `422 tag_not_found`（details 带请求的 tagIds）。tagIds 写入与 note 写入同一事务。

### 2.4 List/Filter/Search（P7A1-05）

Querystring：`q`（≤300）、`tags`（逗号分隔 tag id 单参数，handler 解析+uuid 校验，非法 → 400 validation_error）、
`mood`（enum）、`pinned`（"true"/"false"）、`occurredFrom`/`occurredTo`（`YYYY-MM-DD`）、`sortBy`（allowlist：
`occurredAt`→occurred_at（默认）、`createdAt`→created_at、`updatedAt`→updated_at）、`order`（asc/desc，默认 desc）。
排序 tie-break：`occurred_at / created_at DESC, created_at DESC, id`（稳定）。

SQL 形态（全参数化，沿用 assets 先例）：

- **q 搜索**：`(title ILIKE $n OR content ILIKE $n OR EXISTS (SELECT 1 FROM notes.note_tags nt
  JOIN notes.tags t ON t.id = nt.tag_id WHERE nt.note_id = notes.id AND t.name ILIKE $n))`。
- **多 tag AND**：每个请求的 tag id 一个 `EXISTS (SELECT 1 FROM notes.note_tags nt WHERE nt.note_id = notes.id
  AND nt.tag_id = $n)`，AND 连接（不用 GROUP BY HAVING count——与仓库 EXISTS 风格一致、计划更直白）。
- **occurredFrom/To**：与分组同一表达式比较本地日期：
  `(occurred_at AT TIME ZONE $tz)::date >= $from::date`（`$tz = ctx.time.timezone()` 参数）。
- **dayKey**：SELECT 里带 `(occurred_at AT TIME ZONE $tz)::date::text AS day_key`（focus repository
  `(s.ended_at AT TIME ZONE $1)::date` 先例；timezone 一律参数，**禁 CURRENT_DATE**）。
  `todayKey`/`yesterdayKey`：由 `ctx.time.todayRangeUtc()` 取 start 推 todayKey；yesterdayKey = start - 36h 再取
  local day（或等价地 `startOfLocalDay` 语义复用，禁止前端算）。

### 2.5 分页（D7 拍板）

V1 **不分页**：默认全量返回，但服务端硬上限 `LIMIT 500`，响应带 `total`；`total > items.length` 时前端显示
"Showing first 500 of N — refine filters" 提示。单人 notes 短期到不了 500；limit/offset UI 留给后续
（forward-only，不预建）。

### 2.6 Events（D13 拍板：V1 不声明）

**`capabilities.events: false`，不 publish 任何事件。** 已核实：全仓库 backend/src 无任何 app 事件订阅
（`assets.item.created.v1` / `tasks.task.*` / `focus.session.*` 均无消费者；events 是纯通知语义）。为无消费者的
通知提前声明 capability 正是 P7A1-10 禁止的"滥用"。当出现第一个真实消费者时，在同一变更里翻 capability + 补
`notes.note.created.v1` 等发布（事务提交后 publish），契约向前兼容。

capabilities 定稿：`database: true, storage: false, scheduler: false, events: false`。
manifest：`default_enabled: true`；`widgets: [{ id: quick_note, name: Quick Note }]`（与 FrontendAppModule
widgets 双声明一致）。

## 3. 前端结构（定稿）

```text
frontend/src/apps/notes/
├── index.tsx            # FrontendAppModule：routes + widgets（双声明）
├── api.ts               # NoteView/TagView 类型、fetch helpers、MOODS 元数据（label+BadgeTone 映射）
├── NotesPage.tsx        # timeline + Filters 窗（URL search params）
├── NoteEditorPage.tsx   # 全字段编辑器（"new" 与 ":id" 共用）
└── QuickNoteWidget.tsx  # dashboard widget
```

后端两文件：`backend/src/apps/notes/index.ts`（routes/schema/错误映射/toNoteView）+
`backend/src/apps/notes/model.ts`（纯函数：MOODS、SORT allowlist、`parseTagsQuery`、`dedupeTagIds`、
`normalizeTagName`——零 I/O，unit 可测）。

### 3.1 路由（D10 拍板：编辑器是独立 route，不是 dialog）

```ts
routes: [
  { path: "",      label: "Notes", element: <NotesPage /> },
  { path: "new",   label: "New Note", element: <NoteEditorPage /> },
  { path: ":id",   label: "Edit Note", element: <NoteEditorPage /> },
]
```

resolveRoutes 拼出 `/notes`、`/notes/new`、`/notes/:id`；react-router 静态段 `new` 天然优先于 `:id`，
`useParams` 取 id。理由：Quick Note 的 Open 需要**可深链**的编辑器 URL（`<Link to={/notes/:id}>`，原生 `<a>`
受 `isInteractiveTarget` 保护）；dialog 方案做不到。编辑器内 Save/Cancel 后 `navigate("/notes")`。

### 3.2 Filter 状态（D11 拍板：URL search params）

完全照抄 tasks 先例：`useSearchParams` 持有 `q/tags/mood/pinned/occurredFrom/occurredTo/sortBy/order`，
`q` 250ms debounce 后写回 URL（`replace: true`），Filters 收进 header 按钮面板（复用
`assets-filters`/`px-seg`/`px-select` 样式）。deep-link 友好，零新机制。tag 多选以 chip 按钮组呈现
（点击 toggle 进出 `tags` 参数）。

### 3.3 Timeline（P7A1-06）

- 按 `dayKey` 变化分组；组标题：`dayKey === todayKey` → "Today"，`=== yesterdayKey` → "Yesterday"，否则用
  dayKey 字面量 `new Date(`${dayKey}T00:00:00`).toLocaleDateString()` 格式化（纯展示，不推导"今天"）。
- 条目：title（无则取 content 首行截断）、mood badge（辅助）、tag chips（低视觉权重）、pinned 徽标
  （PixelIcon "check" 不合适——用 PixelBadge tone="warning" `Pinned`；**只标记+可过滤，不置顶重排**——
  P7A1-05/06 未要求重排，timeline 保持时间序）。
- content 预览截断（如 200 chars），完整内容在编辑器/条目展开。
- **禁止** folder sidebar / graph / tree。导航与空态用 EmptyState/LoadingState/StatusMessage 既有组件。

### 3.4 编辑器（P7A1-07）

Title（optional PixelInput）/ OccurredAt（`datetime-local`，复用 tasks 的 `toLocalInputValue`/
`fromLocalInputValue` 模式）/ Mood（可选 select，含 "None"）/ Tags（多选：已有 tag chip toggle + 输入新名
回车即 `POST /tags` get-or-create 后加入选中集）/ Content（textarea，必填）/ Pinned（checkbox）。
Edit 走 PATCH 三态：未变字段 absent；清空字段发 `null`；tags 不变则不发 tagIds。

### 3.5 内容格式（D14 拍板：V1 纯文本）

frontend 无 markdown 依赖（package.json 已核实）。V1：`white-space: pre-line` 纯文本展示，**零新依赖**。
不引入 WYSIWYG/block editor/CRDT/ProseMirror/Tiptap。Markdown-lite 展示（含 sanitize）推迟到有真实需求时
另立任务。

### 3.6 Quick Note widget（P7A1-09/11，D12 拍板）

- 渲染：`<textarea>`（受 isInteractiveTarget 保护）+ Save（PixelButton）；Save 调 `POST /notes` body 只
  `{ content }`（title/mood/tags/occurredAt/pinned 默认即 P7A1-09 要求，无专门路由）。
- 成功后：textarea 清空，显示 `Saved` + **Open**（`<Link to={/notes/${id}}>`，原生 `<a>` 由 interactive
  guard 吞掉点击导航）。Open 之后 widget 回到初始输入态。
- loading/saving：saving 时禁用按钮显示 "Saving…"；error → StatusMessage + Retry（useMutation/useAsync）。
- reload 后数据存在（服务端持久化，无本地 state 依赖）；app disabled → widget 从 dashboard 消失
  （shell 与 enabled apps 求交集），API 404（lifecycle guard）。
- card 其余区域点击导航到 `/notes`（widget 默认 href）。

### 3.7 视觉标识（optional wiring，3 处小改）

`APP_ICONS["notes"]="file"`、`APP_ACCENTS["notes"]="info"`（frontend/src/shared/ui/appIcons.ts）+
`tokens.css` `[data-app="notes"] { --app-accent: var(--px-info); }`。mood→tone（合法 BadgeTone，无 mint）：
great=success、good=info、neutral=neutral、low=warning、bad=danger。app 内样式追加进 `frontend/src/styles/apps.css`。

## 4. 测试矩阵（D15）

| 层 | 文件 | 覆盖点 |
|---|---|---|
| Backend unit | `backend/test/unit/notes-model.test.ts` | MOODS 集合、sortBy allowlist 映射、`parseTagsQuery`（空/单/多/非法 uuid/空段）、`dedupeTagIds`、`normalizeTagName`（trim/长度/空） |
| Backend integration | `backend/test/integration/notes.test.ts` | CRUD 全路径；minimal create（quick note 形态：只 content，断言 title=null/mood=null/occurredAt=now/pinned=false/tags=[]）；nullable title/PATCH 三态（absent/null/值）；mood 非法值 400；tag get-or-create（200 vs 201）；tagIds 去重与 `tag_not_found` 422；tag DELETE 后 note 保留；多 tag AND 过滤；mood/pinned 过滤；occurredFrom/To；q 搜索（title/content/tag name 各一例）；默认排序与 sortBy；**dayKey/todayKey/yesterdayKey**（fixed clock：Asia/Shanghai vs UTC 日界两侧 + `PUT /api/core/settings/platform.timezone` 热切换后 dayKey 变化 + America/New_York DST 日）；limit 500 上限与 total；disabled lifecycle（PUT enabled=false → 全路由 404，数据保留）；persistence（同一 platform 二次查询）；camelCase 断言（响应无 snake_case 键） |
| Frontend component | `frontend/src/apps/notes/NotesPage.test.tsx` | timeline 按 dayKey 分组 + Today/Yesterday 标题；pinned 徽标与 mood badge 渲染；过滤（q/tags/mood/pinned）写 URL 并请求正确 querystring；空态/加载/错误+Retry |
| Frontend component | `frontend/src/apps/notes/NoteEditorPage.test.tsx` | 新建全字段提交；编辑回填与 PATCH 三态 payload（清空发 null、tagIds 替换/不发）；tag 创建-选中流（mock POST /tags 200/201）；content 必填校验；保存后导航 |
| Frontend component | `frontend/src/apps/notes/QuickNoteWidget.test.tsx` | 输入+保存→Saved+Open 链接出现；只发 `{content}`；saving 禁用；error 显示+Retry |
| E2E | `frontend/e2e/notes.spec.ts` | ① Dashboard Quick Note → 输入 → Save → Saved → Open → 落在 `/notes/:id` → 返回 `/notes` → Today 组可见；② /notes/new 全字段（title/mood/tags 新建/occurredAt/pinned）→ Save → timeline 可见 → 按 tag/mood 过滤 + q 搜索命中 → Edit 修改 → 可见 → Delete（ConfirmDialog）→ 消失。独立 spec，参照 focus.spec.ts（CORE=8902、唯一化名称、必要时显式 PUT dashboard.widgets 保证 quick_note 卡片可见） |

集成测试组装照 assets 先例：`resetDatabase()` + `buildFixturePlatform({ manifests: [{ id: "notes",
migrations: [init sql] }], backendModules: { notes: notesApp } })` + `runMigrations` 到 notes schema；
**`backend/test/helpers/db.ts` 的 `APP_SCHEMAS` 加 `"notes"`**（本 worklist 唯一的共享文件改动）。

## 5. File scope

| Task | File | Action |
|---|---|---|
| T01 | `apps/notes/app.yaml`、`apps/notes/README.md`、`backend/src/apps/notes/index.ts`、`frontend/src/apps/notes/index.tsx`、`frontend|backend/src/generated/apps.ts` | NEW（create:app 产物 + manifest 定稿） |
| T02 | `apps/notes/migrations/<ts>-init.sql` | NEW |
| T02 | `backend/test/helpers/db.ts` | MODIFY（APP_SCHEMAS + "notes"） |
| T03-04 | `backend/src/apps/notes/index.ts`、`backend/src/apps/notes/model.ts` | NEW/REPLACE（scaffold stub 替换） |
| T06-08 | `frontend/src/apps/notes/{api,NotesPage,NoteEditorPage,QuickNoteWidget}.tsx`、`index.tsx` | NEW/REPLACE |
| T09 | `frontend/src/shared/ui/appIcons.ts`、`frontend/src/styles/tokens.css`、`frontend/src/styles/apps.css` | MODIFY（optional wiring + app 样式） |
| T05/10/11 | 测试文件（§4） | NEW |

Core（`backend/src/core/**`、`frontend/src/shell/**`、既有 app 代码）：零改动。`platform.spec.ts` 不动。

## 6. Tasks（施工顺序）

- **T01 Scaffold + manifest**（P7A1-01）— `npm run create:app -- notes "Notes"`；改 `apps/notes/app.yaml`
  （description、widget `quick_note`、capabilities 见 §2.6、route /notes、default_enabled: true）。
  验收：`npm run generate:apps:check` 绿；`npm run verify:apps` 绿；App Center 出现 Notes。
- **T02 Migration + APP_SCHEMAS**（P7A1-02/03）— `npm run migration:create -- --scope notes --name init`，
  写入 §1 SQL；`APP_SCHEMAS` 加 notes。验收：`npm run migration:up` 后 psql 可见 `notes` schema 三表三索引；
  `npm run test:integration` 现有套件不红。
- **T03 model.ts 纯函数**（P7A1-02/05）— 验收：notes-model.test.ts 绿（`npm test`）。
- **T04 后端 API**（P7A1-04/05/07/08/10/12）— routes/JSON Schema/AppError 映射/toNoteView/dayKey/todayKey。
  验收：手动 inject 冒烟（create→list→patch→delete、tag upsert）；isolation.test.ts 绿。
- **T05 后端集成测试**（P7A1-13 后端部分）— §4 integration 全覆盖点。验收：`npm run test:integration` 新文件绿。
- **T06 api.ts + NotesPage**（P7A1-05/06）— timeline + URL 过滤。验收：`npm run check` 绿；
  `/notes` 手动可用（分组/过滤/空态）。
- **T07 NoteEditorPage**（P7A1-07/08）— new/:id 双形态。验收：创建→编辑→删除手动全通；PATCH payload 三态正确。
- **T08 QuickNoteWidget + index.tsx wiring**（P7A1-09/11）— 验收：dashboard 卡内输入保存不触发卡导航；
  Saved/Open 工作且 reload 后 note 存在。
- **T09 视觉标识**（optional）— icon/accent/tokens/apps.css。验收：nav 与 dashboard 显示 file 图标 + info accent，
  无 fallback。
- **T10 前端 component 测试**（P7A1-13 前端部分）— §4 三个 test 文件。验收：`npm test`（frontend vitest）绿。
- **T11 E2E**（P7A1-13 e2e 部分）— `frontend/e2e/notes.spec.ts` 独立 spec。验收：`npm run e2e` 全绿
  （含既有 platform/focus/ui spec —— 已核实其 count-4 断言均运行在显式持久化的 4-widget layout 下，
  第 5 个默认 widget 不破坏它们）。
- **T12 Contract 收口**（P7A1-14）— `npm run check && npm test && npm run test:integration && npm run e2e`，
  最后 `npm run verify`；`git diff --check` 干净。验收：全 gates 绿，`platformApiVersion` 仍为 1，
  manifest 结构未偏离 V1。

## 7. Non-goals（引自任务书，全部不做）

Obsidian/Notion 导入、folders/notebooks、wiki links/backlinks、graph、canvas、attachments、rich text editor
（WYSIWYG/block/CRDT/ProseMirror/Tiptap）、AI summary、semantic search、cross-app linking、
calendar/tasks/focus 集成、nested tags/hierarchy/aliases、分页 UI、置顶重排逻辑、事件发布（§2.6）。

## 8. 风险与注意点

- **count-4 e2e 断言**：platform.spec 174/198/205 的精确计数都在测试内先 PUT 4-key layout，notes 默认 widget
  不会破坏；但 notes.spec 自己断言 dashboard 卡片时也要先显式设置 layout（E2E 库跨 run 持久化）。
- **dayKey 双处一致**：SELECT 表达式与 occurredFrom/To 过滤必须用同一个 `(occurred_at AT TIME ZONE $tz)::date`
  参数化形式，避免分组与过滤在时区切换后口径漂移。
- **PATCH tagIds 与 note 更新同事务**：FK 校验失败必须回滚 note 字段更新（23503→422 tag_not_found）。
- **Quick Note Open 的 `<Link>`**：必须是原生 `<a>` 渲染（Link 即是），不要换成 button+navigate —— guard 只认
  DOM interactive 元素。
- **`/notes/new` 与 `/:id`**：确认 react-router 排序（静态优先）在 App.tsx 的扁平 `<Route>` 注册下成立（v6+
  ranking，无需手动排序；e2e 覆盖 `/notes/new` 导航即验证）。
