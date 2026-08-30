# Phase 7A-2 — Assets Category V2（施工前定稿 WORKLIST）

Scope Summary：assets 的 category 从"item 单选一档"升级为"多对多 + 多类筛选 + 颜色落地到 item 卡片"。
一个改造切片：新 migration（`item_categories` 关系表 + 数据回填 + DROP legacy 列）+ `backend/src/apps/assets/index.ts`
（relation CRUD、多类 AND 筛选、faceted counts、响应 camelCase 化、事件升 v2）+ `frontend/src/apps/assets/index.tsx`
（chip 直接筛选、`⋯` 管理拆分、编辑器多选、card 分段色条与彩色 badges）+ 测试（migration/backed integration、
component 重写、新独立 e2e spec）。不改 App Contract V1、不改 Platform Core、`platformApiVersion=1` 不动。
共享文件仅 3 处**纯通用**改动（PixelBadge accent、tokens.css 补 4 组 accent 色对、components.css badge 规则，
见 §8 边界）。读者假定已读 `doc/APP_DEVELOPMENT.md` 与 P7A1 worklist。

---

## 1. Migration（P7A2-01/02，定稿：方案 B——同 migration 内回填后 DROP 列）

新增 `apps/assets/migrations/20260831000007-item-categories.sql`（bare table names；已应用的
2026…01~06 **一个字符不改**）：

```sql
-- P7A2-01/02: items <-> categories becomes many-to-many. Backfill from the
-- legacy single-category column inside the same migration, then drop it:
-- one relation table, one source of truth, no dual-write drift.
CREATE TABLE item_categories (
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);

INSERT INTO item_categories (item_id, category_id)
SELECT id, category_id FROM items WHERE category_id IS NOT NULL;

CREATE INDEX item_categories_category_idx ON item_categories(category_id);

ALTER TABLE items DROP COLUMN category_id;
```

拍板与理由：

- **选 B（回填 + DROP），不选 A（暂留 legacy 列不读）**。任务书要求"最简单且安全的长期模型，不要无限双写"。
  留列意味着每次写 item 都要决定是否同步 legacy 列（不同步=数据撒谎；同步=双写），且 `items.category_id` 上的
  旧 FK（`ON DELETE SET NULL`）与 `item_categories` 的 CASCADE 语义并存会让"删 category"出现两套真相。本仓库
  forward-only、无外部消费者，DROP 是一次性成本。
- **DROP COLUMN 无需显式清理 FK/索引**：Postgres 自动级联删除列上的约束（`items_category_id_fkey`）与只含该列的
  索引（`items_category_idx`）。migration 里不写多余的 DROP，避免版本间差异。
- **回填幂等安全**：runner（node-pg-migrate，`singleTransaction`）每个 migration 一个事务；`INSERT … SELECT` 的
  目标是刚建好的空表，PK 无冲突可能。新库（先跑 01~06 再跑 07）回填 SELECT 命中 0 行；存量库迁入全部单类数据。
  "多 migration 启动安全"由 `checkOrder` + 事务保证，测试矩阵覆盖（§6.1）。
- 未分类 item（`category_id IS NULL`）不产生 relation 行，item 行原样保留——这正是"0 类"状态。
- 命名对齐 notes 先例（`note_tags`→`item_categories`，双向 FK ON DELETE CASCADE，复合 PK，`<table>_<fk>_idx`
  反向索引供"按 category 找 items"与 counts 使用）。

## 2. API shape（P7A2-03/06/07/12/14，定稿）

### 2.1 Response casing：本批全面 camelCase 化（拍板）

assets 现状是 snake_case 直出（历史遗留），而 request body 已经是 camelCase——**API 本身已经两套 casing 混用**
（`acquiredAt` 进、`acquired_at` 出）。本批必须重写全部 item response（加 `categories`），前后端与 assets 专属测试
都要动，顺手在 view boundary 补 per-entity mapper 的边际成本极小，却换来：①出入参对称；②对齐
`doc/APP_DEVELOPMENT.md`"新代码 camelCase"与 notes 先例（P7A1 worklist 明确点名 assets 是反面教材）；③此后
assets 不再欠这笔债。

- 新增 `toItemView(row, categories)` / `toCategoryView(row)` / `toAttachmentView(row)` /
  `toCleanupJobView(row)`（mini_game `toSave` 先例）；**全部** assets 响应（items、categories、attachments、
  maintenance/cleanup-jobs）统一走 mapper。
- 请求 schema 不变（本来 camelCase）。前端 `Item`/`Category`/`Attachment` interface 同步改。

### 2.2 Item view 与 categoryIds 写语义

```
ItemView = {
  id, name, description: string|null, quantity: number,
  acquiredAt: "YYYY-MM-DD"|null, targetLocation: string|null,
  createdAt, updatedAt: ISO-UTC,
  categories: { id, name, color }[]     // ORDER BY name（name UNIQUE，天然稳定）
}
```

- **GET /items 的 categories 排序拍板：按 name 升序**。与 `GET /categories`（ORDER BY name）和 notes 内嵌
  tags（`ORDER BY t.name`）一致；stripe/badge 展示顺序直接跟随响应顺序，前端不再排序。
- **写接口用 `categoryIds: string[]`**（create/edit 同名）：
  - POST /items：`categoryIds?: string[]`（缺省 `[]`）；**请求内重复 id 静默去重**（`new Set`，notes
    `dedupeTagIds` 先例；PK 反正会拒重复，去重让重试幂等且报错不困惑）。
  - PATCH /items/:id：`categoryIds` **absent=保持关联不变；`[]`=清空全部；非空 list=整体替换**（DELETE 全部 +
    `INSERT … SELECT $1, unnest($2::uuid[])`）；`categoryIds: null` → `400 validation_error`（notes tagIds 同款
    ——用 `[]` 表达清空，语义无歧义）。
  - item 字段更新与 relation 替换**同一 `ctx.database.withTransaction`**（notes `replaceNoteTags` 先例）。
- **invalid category id 拍板：`422 category_not_found`**，对齐 P7A1 `tag_not_found` 模式（details 带请求的
  categoryIds），**替换**现有 `invalid_reference`。理由：notes 已把"多对多 relation 引用不存在"确立为
  `<entity>_not_found` 命名族；`invalid_reference` 泛指不清、无法区分哪个引用失败；本 API 无外部消费者
  （单用户平台、前端同批改），无兼容包袱。实现：tx 内 FK 23503 → catch → 映射（不再依赖裸 INSERT 的 23503）。
- 404 语义不变（item/category 不存在仍 `404 not_found`）。

### 2.3 列表筛选（P7A2-06/07/14）

Querystring：`q` / **`categories`（逗号分隔 category id 单参数，替换 `categoryId`）** / `targetLocation` /
`acquiredAfter` / `acquiredBefore` / `createdAfter` / `createdBefore` / `sortBy` / `order`。

- **多类 AND**：每个请求 id 一个 `EXISTS (SELECT 1 FROM assets.item_categories ic WHERE ic.item_id = items.id
  AND ic.category_id = $n)`，AND 连接（notes 多 tag 同款；不用 GROUP BY HAVING）。全部参数化，id 只进参数位。
- `categories` 解析：handler 拆分逗号 → 每段必须 uuid，**格式非法 → `400 validation_error`**（notes
  `parseTagsQuery` 先例）；格式合法但不存在 → 正常返回空集（不 422，与 notes tags 行为一致）。
- **q 搜索（P7A2-14）**：`(name ILIKE $n OR description ILIKE $n OR EXISTS (SELECT 1 FROM
  assets.item_categories ic JOIN assets.categories c ON c.id = ic.category_id WHERE ic.item_id = items.id AND
  c.name ILIKE $n))`——ANY assigned category name。
- **交叉筛选（P7A2-07）**：conditions 数组照旧 `AND` 拼接，categories 条目只是其中一员；sortBy allowlist 与
  tie-break（`<col> <dir> NULLS LAST, created_at DESC, id`）**一字不改**。

### 2.4 Faceted counts（P7A2-12，拍板：完整 faceted 语义，服务端计算）

`GET /items` 响应升级为：

```
{ items: ItemView[], counts: { all: number, categories: Record<string, number> } }
```

- **语义（写死进实现注释）**：`counts` = 在**除 categories facet 之外的所有当前过滤条件**（q/location/两个日期
  区间）下统计——`all` 为不限类的 item 总数；`categories[cid]` 为"该类下匹配其余过滤条件的 item 数"。因此选中
  类 A 时，类 B 的 count 不会被压成 0；同一 item 属于多类时在每个类的 count 里各计 1（PK 保证类内不重复计）。
  `categories` 覆盖**全部现存 category（含 0）**，chip 永远有数可显。
- SQL（与 items 查询共用同一个"非类条件" builder，避免两处口径漂移）：

```sql
SELECT count(*)::int FROM assets.items WHERE <non-category conditions>;          -- all
SELECT ic.category_id, count(*)::int FROM assets.items i
JOIN assets.item_categories ic ON ic.item_id = i.id
WHERE <non-category conditions on i> GROUP BY ic.category_id;                    -- byCategory
```

- 为什么不做"全局无过滤 counts"的简化：现有 UI 的 chip count 本来就随 q/日期过滤联动（client-side 从结果集
  算），faceted 是其直接修正（只是把"类别维度"从统计条件里剔除）；纯全局 counts 会和可见结果集脱节，形成另一种
  不一致。两条聚合查询单人规模无性能顾虑。
- 前端删除 `countFor`（从结果集 client-side 计数的旧实现，正是 bug 根源），chip 直接读 `counts`。

### 2.5 删除与 summary（P7A2-13）

- DELETE /categories/:id：SQL 不变（`item_categories.category_id … ON DELETE CASCADE` 级联解关联，items 保留）；
  handler 上方注释从 "ON DELETE SET NULL" 改为 cascade 语义；404 不变。
- `GET /summary` 不变（items=行数、categories=类数，与关联无关）。

## 3. Events（P7A2-15，拍板：停发 v1，新发 v2）

- **停止发布 `assets.item.created.v1`；新增发布 `assets.item.created.v2`，payload
  `{ id, name, categoryIds: string[] }`**，在 create 事务**提交后** publish（focus/notes "events after commit"
  先例；现状 publish 在 INSERT 后、relation 写入将进 tx，时点必须随之挪到 tx 外）。
- 理由：已核实全仓库无任何 `subscribe("assets.item.created.v1")`（backend/src 仅 assets 自己 publish，见
  `backend/src/apps/assets/index.ts:382`；事件总线纯进程内通知）。事件版本原则禁止偷偷改 v1 的 payload 语义
  （单 `categoryId` → 数组是破坏性变更）；既然 v1 零消费者，保留 v1 + 并行发 v2 会让"一次创建"产生两条通知，
  是死代码加噪音。若未来出现 v1 消费者再迁移，规则同样是"v1 冻结 + 发 v2"。
- `app.yaml` capabilities `events: true` 保持（仍在发布 v2）。manifest `version` 0.1.0 → 0.2.0（功能版本演进）。

## 4. 前端交互与视觉（P7A2-04/05/08/09/10/11）

文件仍为单文件 `frontend/src/apps/assets/index.tsx`（不拆分，控制 diff 面；见 Non-goals）。

### 4.1 Chip：主点击=筛选，`⋯`=管理（P7A2-04/05）

- **chip 本体是一枚 toggle 过滤按钮**：`aria-pressed={active}`，点击立即把该类 id 加入/移出 URL 的
  `categories` 参数（经 `setParam` → useAsync 重发请求）。选中态复用既有 `.px-chip[aria-pressed="true"]`
  反色样式（components.css 已有，notes tag chips 同款）；色点（`px-cat-dot`）留在 chip 内，选中时仍可见——
  即"选中明显"。All chip：`categories` 为空即 pressed，点击清空类集。
- **管理拆分拍板：assets 内部 inline 展开，不做浮层 menu、不加共享组件**。每个 chip 旁一枚紧凑 ghost
  icon-button（现有 `menu` glyph——16×16 三横线，已存在于 `icons.tsx`，不新增 glyph），`aria-label="Manage
  category X"`、`aria-expanded`，点击 toggle 与现在完全相同的 inline `px-chip__tools` 行（edit/trash 两枚
  icon-button）。理由：零新共享面（P7A2-17 边界最小化）、复用 `.px-chip-group`/`.px-chip__tools` 既有 CSS、
  无浮层定位/外点关闭/a11y 复杂度；details/summary 对"summary 里放按钮组"语义别扭。`px-chip--open` 反色样式
  从 chip 挪到 manage 按钮的展开态。
- 删除前 confirmation 沿用 ConfirmDialog，**文案改多类语义**：`Delete "X"? Items keep their other categories;
  items that only have this one become uncategorized.`（P7A2-13）。

### 4.2 URL 多值形态（P7A2-06/08）

- **拍板：单参数 `categories`，值为逗号分隔 id**——与 notes 的 `tags` URL 参数逐字同构（repo 内唯一的多值
  filter 先例），assets 现有"单值参数 + setParam/delete"机制零改动：`setParam("categories",
  nextIds.join(","))`，空集 delete 参数。不用 `?category=a&category=b`（URLSearchParams.getAll 与后端
  Fastify querystring 都要另开一套收集逻辑，且仓库无先例）。
- `itemsQueryString` / `ASSETS_FILTER_KEYS` 里 `categoryId` → `categories`；**active categories 计入 filter
  badge 数**（presence 计 1，不按类数膨胀）；`Reset` 清空全部 searchParams（categories/q/location/dates 一并），
  已是现实现。
- **Filters panel 清理（P7A2-08）**：删除 panel 里的 category `<select>`（重复入口）；Search / Location /
  Acquired range / Added range / Sort / Order / Reset 原样保留。搜索框 placeholder "Search name or category…"
  保留（语义仍准确）。

### 4.3 Item 编辑器多选（P7A2-09）

- category 字段从 `<select>` 换成 **chip toggle 组**（notes 编辑器 tags 逐字同构）：每类一枚 `px-chip` 按钮
  （内含色点 + name），`aria-pressed` 进出选择集，0..N；不用原生 select multiple。
- editor state `categoryId: string` → `categoryIds: string[]`；edit 回填 `item.categories.map(c => c.id)`。
- 提交：create 恒发 `categoryIds`（可为 `[]`）；edit 按当前实现的最小 diff 哲学——**与原集合（排序后比较）
  相同则 absent，否则发新数组**（notes "tags 不变则不发 tagIds" 同款）。

### 4.4 Card：分段色条 + 彩色 badges（P7A2-10/11）

- **surface 统一**：卡片背景/边框/阴影不动。顶部加一条 `inv-card__stripe`（卡片 padding 内第一行，
  `display:flex; height:4px;`），N 段等分（每段 `flex:1`）。
- **实现拍板：纯 div flex 分段，不用 linear-gradient**。每段一个 `<i class="inv-card__stripe-seg"
  data-accent="mint">`，apps.css 里按既有 `px-cat-dot[data-accent=…]` 完全相同的模式写 9 条
  `background: var(--px-<accent>)` 规则。div 比 gradient stop 好在：色值→token 映射走 `data-accent` 属性选择
  器（仓库既有用色惯例，px-cat-dot/app-accent-swatch/app-card__icon 三处先例），无需 JS 拼 gradient 字符串，
  DevTools 可解释，段与类一一对应。
- **0 类 = 不渲染 stripe 元素**（不是灰条——灰条是噪音）；**无自定义色（color=null）的段：不设
  `data-accent`，CSS 默认 `background: var(--px-ink-muted)`**——稳定 fallback，不随机、不按 id 漂移。
- **footer badges**：类别 badge 用 PixelBadge 新增的通用 `accent` prop（见 §8）：`<PixelBadge accent={c.color}>`
  彩色；color=null → 不传 accent，落回 neutral（现状）。数量规则：0 类无 badge；1..3 全显；>3 显示前 3 个
  （响应序=name 升序）+ 一枚 neutral `+N` badge，`+N` 的 `title` 属性列出剩余类名（最简稳定展开：tooltip，
  不加交互）；**详情页 deflist 的 Category 行显示全部**（彩色 badge 列表）。Location badge（tone=info）不变。

## 5. 共享 UI 改动（P7A2-17 允许的"纯通用"范围，共 3 处）

1. `frontend/src/shared/ui/PixelBadge.tsx`：新增可选 `accent?: PixelAccent` prop → 渲染 `data-accent={accent}`。
   纯通用（平台 accent 体系，无 assets 语义），配新 `PixelBadge.test.tsx`（accent 透传 + 默认 tone 不变）。
2. `frontend/src/styles/components.css`：`.px-badge[data-accent="x"] { color: var(--px-x-text);
   background: var(--px-x-light); }` 九条——完全复刻既有 tone badge 的"浅底深字"样式语言，仅补齐 accent 维度。
3. `frontend/src/styles/tokens.css`：补齐 mint/yellow/violet/coral 四组缺失的 `-light`/`-text` 色对（现只有
   primary/success/warning/danger/info 五组，与 ACCENT_OPTIONS 九色不对称）：
   `--px-mint-light:#d9ebe4 / --px-mint-text:#3e6b58`；`--px-yellow-light:#f4e7c2 / --px-yellow-text:#7a5f1d`；
   `--px-violet-light:#e4dff0 / --px-violet-text:#57496f`；`--px-coral-light:#f3ddd6 / --px-coral-text:#8a4735`。
   （取值按既有色对的"同色相降饱和浅底 + 加深文字"模式推导；如实现时视觉不过关，允许在保持"九色统一规则"的
   前提下微调 hex，规则本身不许变。）

stripe 用**实色 accent**（非文本元素，同 px-cat-dot），不走 -light 对。

## 6. 测试矩阵（P7A2-16，原文照收逐条落位）

### 6.1 Migration — 新 `backend/test/integration/assets-migration.test.ts`

用 `runMigrations` + 临时目录分步控制：①mkdtemp 拷入 01~06 六个 SQL，跑到该目录（停在 legacy 模型）；
②SQL 直插 `INSERT INTO assets.items (id, category_id, name)` 造"单类 item ×2 + 未分类 item ×1"；③对真实
migrations 目录再跑 `runMigrations`（只应用 07）→ 断言：两条 relation 行存在且 category_id 正确、未分类
item 无 relation 行且行完好、`information_schema.columns` 中 items 已无 category_id、`items_category_idx`
不存在；④重复 runMigrations → no-op 不报错（多 migration 启动安全）。

### 6.2 Backend integration — 改 `backend/test/integration/assets.test.ts` + `assets-consistency.test.ts`

- `assets.test.ts` 顶部 migration 列表从手写 5 个文件（已漏 cleanup-jobs）改为 `readdirSync` 全量（consistency
  文件既有模式），新 migration 自动纳入。
- **存量断言适配**：全部 snake_case 响应断言（category_id/target_location/acquired_at/created_at/
  content_type…）→ camelCase；`invalid_reference` 用例 → `422 category_not_found`（body 传 categoryIds）；
  "deleting a category nulls item categories (ON DELETE SET NULL)" → 改为"删类级联解关联、items 保留、多类
  item 保留其他类"。
- **新增 describe（API 矩阵）**：0/1/N 类 create+list 嵌入（categories 按 name 序）；categoryIds 重复 id 去重；
  invalid id → 422 category_not_found（create 与 PATCH 各一）；`categoryIds: null` → 400；PATCH absent（关联不
  变）/`[]`（清空）/list（整体替换）；DELETE category → relation 级联、item 保留且其余类完整；q 按 ANY
  assigned category name 命中（含多类 item）；`categories=a` 单选、`categories=a,b` AND（交集）、格式非法
  uuid → 400；categories AND q AND targetLocation AND acquired range 交叉一例；sorting 用例照旧跑通（unchanged）；
  **counts faceted**——选类 A 后 `counts.categories[B]` 仍为真值、多类 item 在两类 count 各计 1、
  counts.all 不受类筛选影响、q 生效时 counts 同步收窄。
- `assets-consistency.test.ts`：readdirSync 已兼容；仅改 multipart 响应断言 `content_type` → `contentType`
  （及其余 snake 键）；文件其余逻辑（cleanup 队列）与 item 模型解耦，不受影响。

### 6.3 Component — 重写 `frontend/src/apps/assets/index.test.tsx`

存量 5 例处置：①"creates an item through the editor dialog" **保留并加强**（断言 POST body 含
`categoryIds: []`；点选两类后断言 ids 进 body）；②"loads items with the query string from the URL" **保留**
（补一例 `categories=a,b` 透传到请求 querystring）；③"reveals category manage actions after clicking the chip"
**重写**——chip 主点击断言 `aria-pressed` 翻转 + URL `categories` 写入 + items 请求刷新；管理动作改由
"Manage category X" 按钮展开断言；④"collapses filters behind a header button" **保留**（补断言 panel 内
`Filter by category` select 不存在）；⑤"differentiates empty inventory from no matches" **保留**。
新增：chip 二击取消（URL 参数删除）；两类同时 active（URL `categories=a,b`）；编辑器多选回填与替换提交；
card 彩色 badges（断言 badge `data-accent`）与分段 stripe（断言段数/data-accent/0 类无 stripe）；>3 溢出
`+N` badge 且只显 3；chip counts 来自响应 `counts` 块（选中 A 后 B 的 count 不为 0）。fixture mock 升级：
items 带 `categories` 数组、items 响应带 `counts` 块、categories 带 color。

### 6.4 E2E — 新独立 `frontend/e2e/assets-category.spec.ts`；`platform.spec.ts` 不动

- **拍板：新独立 spec**（focus.spec/notes.spec 先例；e2e policy 明确 platform.spec 只 pin shipped app set 的
  导航/App Center/widget 面）。三条流程：①创建 3 类 item → 卡片出现 3 枚彩色类 badge + 三段 stripe；②点类
  A chip → 列表立即收窄且 URL 含 `categories=<A>` → 再点 B → AND（只剩同时属 A、B 的 item）→ reload → 筛选
  保持（deep-link 持久化）；③Manage → Edit → 换 color → 保存 → 卡片 badge/stripe 颜色变化。沿用 notes.spec
  纪律：E2E 库跨 run 持久化，用户可见字符串全部 timestamp-unique。
- **platform.spec 现有 assets 流程不需要维护，理由**："assets: create, search and see the item" 只用
  New Item 对话框的 name 字段 + Filters 面板的搜索框（P7A2-08 明确保留）+ 卡片链接文本——多选控件替换
  select、chip 行为改造、面板删 dropdown 均不触碰这些选择器；"disabling an app" 流程只走 create+可见性，
  同样不受影响。施工后跑一遍 `npm run e2e` 实证（T09 验收项）。

## 7. File scope 与边界（P7A2-17）

| Task | File | Action |
|---|---|---|
| T01 | `apps/assets/migrations/20260831000007-item-categories.sql` | NEW |
| T02 | `backend/src/apps/assets/index.ts` | MODIFY（relation/筛选/counts/casing/v2 事件） |
| T01 | `apps/assets/app.yaml` | MODIFY（version 0.2.0） |
| T03 | `backend/test/integration/assets.test.ts`、`assets-consistency.test.ts` | MODIFY |
| T04 | `backend/test/integration/assets-migration.test.ts` | NEW |
| T05 | `frontend/src/shared/ui/PixelBadge.tsx`（+`.test.tsx` NEW）、`frontend/src/styles/tokens.css`、`components.css` | MODIFY/NEW（§5 三处通用改动） |
| T06 | `frontend/src/apps/assets/index.tsx`、`frontend/src/styles/apps.css` | MODIFY |
| T07 | `frontend/src/apps/assets/index.test.tsx` | MODIFY/REWRITE |
| T08 | `frontend/e2e/assets-category.spec.ts` | NEW |

**禁改**：`backend/src/core/**`、`frontend/src/shell/**`、Contract V1（manifest 结构/AppContext/capability 语义）、
global lifecycle、其余 app（tasks/mini_game/focus/notes）及其测试、`backend/test/helpers/db.ts`（assets 已在
APP_SCHEMAS，无新 schema）。共享文件仅 §5 三处且必须 generic + 有测试 + 无 assets 语义；`icons.tsx` 不加 glyph。

## 8. Tasks（施工顺序）

- **T01 Migration + manifest**（P7A2-01/02）— 写 §1 SQL + app.yaml version。验收：`npm run migration:status`
  显示 07 pending；`npm run migration:up` 后 psql 可见 item_categories 双 FK/复合 PK/反向索引、items 无
  category_id 列、存量单类数据已入 relation（开发库实测）。注意：T01 落地后后端旧代码即读写不存在的列，
  **T01+T02 必须同一施工批提交**，期间 `npm run test:integration` 允许短暂红（assets 两个文件），其余套件不受影响。
- **T02 后端重写**（P7A2-03/06/07/12/13/14/15 + casing）— view mappers、item_categories 读写（tx +
  23503→category_not_found）、`categories` querystring（AND EXISTS + uuid 校验）、faceted counts、搜索 EXISTS、
  事件 v2（commit 后 publish）、删除注释与 404 不变。验收：isolation.test.ts 绿；手动 inject 冒烟
  （create 2 类→list 嵌入→PATCH 替换/清空→AND 筛选→删类）。
- **T03 后端集成适配**（§6.2）— 验收：`npm run test:integration` 全绿（含未改的其他 app 套件）。
- **T04 Migration 集成测试**（§6.1）— 验收：新文件绿。
- **T05 共享 UI 三件套**（P7A2-10/11 前置）— PixelBadge accent + 测试 + tokens/components 规则。验收：
  `npm test`（PixelBadge.test.tsx）绿；`npm run check` 绿。
- **T06 前端页面改造**（P7A2-04/05/06/08/09/10/11/12/13）— chip toggle/管理拆分/URL 多值/面板清理/编辑器多选/
  stripe/badges/counts/删除文案 + apps.css（stripe、manage 按钮、chip 组间距）。验收：`npm run check` 绿；
  手动全流程可用（筛选即点即得、reload 保持、多选编辑、>3 溢出、0 类无 stripe）。
- **T07 Component 测试重写**（§6.3）— 验收：`npm test` 前端全绿。
- **T08 E2E**（§6.4）— 新 spec 三流程。验收：`npm run e2e` 全绿（含未改动的 platform/focus/notes/ui spec——
  实证 §6.4 的"不需维护"判断）。
- **T09 收口**（P7A2-17 全边界自查）— `npm run check && npm test && npm run test:integration && npm run e2e`
  → `npm run verify`；`git diff --check` 干净；确认 §7 禁改清单零触碰、`platformApiVersion` 仍为 1。

## 9. Non-goals（全部不做）

类嵌套/层级、类重排拖拽、类合并、item 卡片整卡着色、跨类 OR 筛选（本批只有 AND）、counts 的类组合预览
（选 A+B 会剩几个）、分页、facet UI 通用化/共享 faceted 组件、`+N` 点击展开浮层（tooltip 即最简稳定方案）、
attachments 按 category 过滤、事件重放/持久化、`index.tsx` 文件拆分、assets API 分页/缓存、给 stripe 加动画。

## 10. 风险与注意点

- **T01 落地窗口**：migration DROP 列后旧后端代码立刻坏——T01 与 T02 同批施工、同批提交，不得只落 migration。
- **回填测试的真实性**：`runMigrations` 以"已应用记录"判进度，§6.1 必须用临时目录只含 01~06 才能停在 legacy
  模型；断言依赖 `checkOrder`，勿在临时目录里改文件名。
- **counts 与 items 口径漂移**：两处 WHERE 必须由同一个 conditions builder 生成（counts 少拼 categories
  条件），否则 faceted 语义静默失真——这是 P7A2-12 最可能的回归点，集成测试的 counts 断言要覆盖"类筛选
  active 时其他类 count 非零"。
- **PATCH 三态回归**：`categoryIds` 是数组型三态（absent/[]/list），与 nullable 字段的 absent/null/值 容易混；
  `null` 必须显式 400，勿静默当 clear（notes 已踩过的语义坑）。
- **camelCase 扫尾**：响应 mapper 覆盖四个实体（items/categories/attachments/cleanup-jobs），漏掉 cleanup-jobs
  会留下最后一处 snake 直出；集成测试里 `content_type`/`storage_key` 断言在两处文件都有。
- **e2e 持久库**：`assets-category.spec.ts` 的名称/类名必须 timestamp-unique；类别名有 UNIQUE 约束且种子
  migration 已占 6 个中文名，测试自建类用英文+时间戳。
- **aria 语义迁移**：chip 从 `aria-expanded`（展开菜单）变 `aria-pressed`（选中）——屏幕阅读器语义完全不同，
  component 测试断言旧 `aria-expanded` 的地方要一起改，别只改交互。
- **`menu` glyph 的语义**：三横线在 chip 旁读作"manage"可接受；若实现中发现辨识度差，备选是按钮文本 `⋯`
  （pixel 字体无此字形会 fallback，视觉略破）——二选一在 T06 定稿，不再加新 glyph。
