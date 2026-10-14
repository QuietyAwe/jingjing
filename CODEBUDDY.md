# Jingjing — 端侧隐私型情感陪伴记忆引擎

基于 React Native (Expo) 的情感陪伴 App，核心是一套**运行在设备本地的记忆引擎**：所有对话记忆存放在端侧 SQLite，不依赖任何服务端存储，通过"短期记忆巩固 + 冷记忆随机扰动"两条异步流模拟人类的记忆演化，让 AI 角色在时间维度上保持连贯的人格与共同经历。

---

## 一、项目定位

| 项 | 说明 |
| --- | --- |
| 包名 | `jingjing`（Expo Router 入口 `expo-router/entry`） |
| 平台 | Android / iOS / Web（Expo SDK 54） |
| 存储 | 全部端侧：`expo-sqlite` 存记忆，`AsyncStorage` 存配置与聊天记录 |
| 模型 | OpenAI 兼容接口，默认 DeepSeek；前后台双模型路由 |

### 核心机制

- **增量补式记忆巩固**：每 10 轮对话触发一次后台 LLM 提取，把近期对话沉淀为「记忆事件 + 记忆片段」，并增量 Merge 进用户画像。会话启动时还会静默**补巩固**上次未巩固的积压历史（后台分批、不阻塞输入）；巩固写入的时间戳**沿用对话消息自身时间**（批末消息时间），不记成巩固执行时刻。
- **冷记忆扰动（灵光一闪）**：检索时按概率抽一条低活跃度的冷记忆注入上下文，制造"突然想起"的效果；**优先挑与当前输入有弱关联的**（不再是纯随机）。
- **艾宾浩斯衰减**：记忆活跃权重随时间衰减，权重影响检索排序。
- **记忆分层（gist / summary）**：每条片段同时存一句话概要 `gist` 与详细描述 `summary`。活跃度高 → 注入完整描述；活跃度低 → 只留一句话印象。详见下文的「记忆分层机制」。
- **滑动窗口**：只把最近 `context_history_rounds`（默认 **10**）轮对话发给模型，与巩固触发频率解耦。
- **冷启动兼容**：空库时套用冷启动模板与默认占位符，首次对话也能自然开场。

### MVP 边界

- **范围内**：本地 SQLite、纯 JS 分词检索（先事件后片段）、衰减、滑动窗口、巩固流、冷启动降级、参数配置解耦、前后台模型路由、游戏系统（4 款）、心情动态（类朋友圈）。
- **范围外**：云端同步、多账号、服务端存储、多模态（语音/图片）记忆、原生 FTS5 分词；动态的点赞/转发/删除编辑（后续迭代）。

---

## 二、快速开始

```bash
npm install
npm start          # 启动 Expo Dev Server
npm run android    # 运行 Android
npm run ios        # 运行 iOS
npm run web        # 运行 Web
```

首次启动需在**设置页**填写 `API Key` 与 `Base URL`（默认 DeepSeek），配置保存在 AsyncStorage。不配置 Key 时，巩固流的后台提取会失败（保留计数、下次重试），聊天仍可用。

云构建（Android APK）：

```bash
eas build --platform android      # 配置见 eas.json
```

### OTA 升级流程（preview 渠道）

> **触发条件**：用户明确说「要 OTA 升级 / 推送 OTA」时，严格按此 4 步执行。仅限 JS/TS 改动；含原生改动（新增 native 依赖、改 app.json 插件/图标等）必须 `eas build` 重新打包，不能走 OTA。

1. **递增版本号**：`src/version.ts` 的 `RELEASE_VERSION` patch +1（如 `1.0.1` → `1.0.2`）——这是设备上可见的版本号。**不要改 `app.json` 的 `version`**：`runtimeVersion` 策略为 `appVersion`，改它会改变运行时版本，已装设备会再也收不到 OTA。
2. **推送**：`eas update --channel preview -m "<改动摘要>"`（直接打包工作区，未提交改动也会包含；不必先 commit）。
3. **验证**：`eas update:list --branch preview` 确认状态 published；必要时 `eas update:insights <group-id>` 看设备是否已启动新包。
4. **告知用户**：从最近任务划掉 App 重开 **两次**生效（首次下载、再次应用）；「设置 → 版本信息」核对**发布版本**号是否已变。

---

## 三、技术栈

```
Expo SDK 54 · React 19.1 · React Native 0.81
TypeScript 5.9 · expo-router 6 · expo-sqlite 16
Zustand 5 · openai v4 · dayjs · AsyncStorage · react-native-sse
```

---

## 四、目录结构

```
app/                    # expo-router 文件路由
  _layout.tsx           # 根布局（挂载 useMomentsEngine 发帖/回评调度，任何页面都在跑）
  chat.tsx              # 二级聊天页（微信式两层导航第二层，左上「返回」回会话列表）
  (tabs)/index.tsx      # 一级会话列表页（AI 会话条 + 最后消息预览，预留多联系人）
  (tabs)/moments.tsx    # 心情动态页（feed / 发帖浮层 / 评论线程）
  (tabs)/settings.tsx   # 设置页
src/
  components/           # 通用 UI：ChatBubble、InputBar、CollapsibleSection、MomentCard、MomentComposer + 游戏卡片（Bomb / YachtDice / YachtScore / TruthDare）
  db/                   # SQLite 连接、建表（schema.ts）、CRUD（queries.ts）
  moments/              # 心情动态模块：engine.ts（发帖调度）、service.ts（发帖/评论与 AI 互动）、memory.ts（动态记忆提取）
  game/                 # 4 款游戏：twentyQuestions（20问）/ bomb（数字炸弹）/ yacht（快艇骰子）/ truthDare（真心话大冒险），各含 engine·ai·prompt
                        # 顶层另有：memory.ts（对局记忆提取）、judge.ts（20问是非判定）、prompt.ts（游戏区 Prompt）、subjectPicker.ts（谜底选取）
  llm/
    client.ts           # OpenAI 客户端单例（API Key / Base URL 管理）
    foreground.ts       # 前台对话：SSE 流式 / 非流式
    background.ts       # 后台任务：巩固提取、作息表生成（JSON mode）
  memory/
    chatHandler.ts      # 聊天主流程编排
    retrieval.ts        # 检索 + 灵光一闪
    tokenize.ts         # 纯 JS 分词
    decay.ts            # 艾宾浩斯衰减
    consolidation.ts    # 巩固流（10 轮触发）
    scheduler.ts        # 周行为时间表生成与当前状态查询
    eventChecker.ts     # 事件（约定/安排）隐形提醒：临近/过期注入提示词，归档转状态
  prompt/
    defaultConfig.json  # 默认提示词配置
    config.ts           # 配置读写（AsyncStorage 覆盖层）
    assembler.ts        # Prompt 拼装与模板渲染
  store/
    chatStore.ts        # 聊天消息 + 调试日志（persist）
    settingsStore.ts    # API Key / 开关 / 主题色
    metaStore.ts        # 系统元数据（轮次、锁等运行时状态）
  theme/                # 浅色/深色色板（colors.ts）+ useTheme.ts
  utils/                # text.ts（splitForChat 气泡分段）、backup.ts（备份导出/导入）、holidays.ts（周几/法定节假日调休表，[today]/[now] 渲染）
  types/schema.ts       # 全局类型定义
docs/                   # 设计稿（如 prompt-editor-redesign.md）
```

---

## 五、数据模型（SQLite）

| 表 | 字段 |
| --- | --- |
| `memory_events` | `id` PK、`event_text`、`timestamp`、`active_weight`(1-100)、`last_accessed`、`priority`(1-9)、`memory_kind`(daily/episode)；索引 `idx_events_weight (active_weight DESC)` |
| `memory_fragments` | `id` PK、`index`（父事件 ID，**列名为 `index` 而非 `event_index`**）、`timestamp`(ISO8601)、`gist`(≤20 字一句话)、`summary`(80-120 字，**含关键细节与情绪**)、`keywords`(逗号分隔，检索用，含同义说法)、`priority`(1-9)；索引 `idx_fragments_index ("index")`。**已无 `emotion` 列**：2026-10-02 下线，迁移时把老内容并进 `summary` 后 `DROP COLUMN` |
| `system_metadata` | `key` PK、`value`；常用 key：`is_locked`、`turn_counter`、`last_consolidated_id` / `last_consolidated_at`（巩固游标，按消息 id 锚定）、`last_consolidated_index`（旧下标游标，仅兼容与调试）、`default_event_id` |
| `user_info` | key-value 分片：`basic_identity`、`social_graph`、`traits`、`states`、`events`（属性/状态/事件 三桶，巩固流增量 Merge，见「用户画像」）；**用户称呼的唯一真相源**为 `basic_identity.nickname`。旧键 `preferences`/`psycho_state`/`life_quests` 读到时自动迁移删除 |
| `behavior_schedule` | `id` PK、`week_start`、`day_of_week`(0-6)、`time_slot`(0-4)、`activity`、`created_at`；索引 `idx_schedule_week`。**存的是 AI 自己的作息**，用于状态区注入 AI 当前在做什么 |
| `game_sessions` | `id` PK、`game_type`(twenty_questions/yacht/bomb/truth_or_dare)、`mode`、`status`(playing/won/lost/abandoned)、`secret`、`secret_source`(public/memory)、`question_count`、`turns`(JSON 存各游戏状态机)、`started_at`、`ended_at`、`result_note`(结束摘要，供上下文合并) |
| `moments` | `id` PK、`author`(user/ai)、`content`、`mood`(开心/平静/低落/烦躁/期待)、`created_at`；索引 `idx_moments_created` |
| `moment_comments` | `id` PK、`moment_id`、`author`(user/ai)、`content`、`created_at`；索引 `idx_comments_moment` |
| `post_plan` | `id` PK、`week_start`、`day_of_week`(0-6)、`time_slot`(0-4)、`theme_hint`、`status`(pending/posted/skipped)、`created_at`；索引 `idx_post_plan_week`。**周发帖计划**，随作息表同一请求生成 |

时段编码：`0=早(6-9) 1=上午(9-12) 2=午(12-15) 3=下午(15-18) 4=晚(18-23)`，0-6 点为深夜特殊处理（随机「已睡/被叫醒/失眠」等状态）。

> 历史上 `memory_events` 曾有 `"index"` 与 `is_archived` 两列：`index` 全仓无读取点，`is_archived` 随做梦流下线失去写入方（恒为 0）。两者已在 `initSchema()` 的迁移中删除（`DROP COLUMN`，旧设备上失败也不影响，全部 SELECT 使用显式列名）。

## 记忆分层机制（gist / summary）

每条记忆片段写两遍：一句留给「快忘了」的时候，一段留给「还记得」的时候。

| 字段 | 规格 | 用途 |
| --- | --- | --- |
| `gist` | ≤20 字一句话，含 `[user]` | 记忆变淡后只剩的印象 |
| `summary` | 80~120 字，含 `[user]` `[time]`，写清「发生了什么 + 关键细节 + 当时情绪」 | 想起来时的完整细节 |

**渲染规则**（`assembler.ts` 的 `buildMemorySection`）——像人的「想起」**逐条**分层，想起一件事不把整段往事全部擦亮：

| 场景 | 注入内容 |
| --- | --- |
| 命中事件 · 被当前话题唤起的片段 | 完整 `summary`（刚想起来的细节，不论多年份；`cuedFragmentIds` 判定见「检索与分词」） |
| 命中事件 · 其余片段 | 按**片段自身年龄**过遗忘曲线逐条决定：新 → `summary`，旧 → `gist` |
| 未命中事件 | 按事件实时权重决定最新一条给 `summary` 还是 `gist`（整体熟悉感） |

命中事件最多注入 4 条片段（最早 1 + 最近 3，**被唤起的必保**，超额先丢未唤起且更旧的）。详略阈值 = `detail_visible_weight`（设置「记忆流转阈值」可调，默认 **60**；调高=更多记忆变简略）× priority 系数（见「记忆引擎行为约定·衰减」）。

`gist` 为空时（老数据、手动新增未填）回退为 `summary` 前 24 字，保证分层渲染永远有内容。

**写入方**：巩固流（`background.ts` 提取指令）、游戏记忆（`memory.ts`）、20问（`twentyQuestions.ts`）、四款游戏的 `insertEpisode` 调用点（`chat.tsx`）、心情动态记忆（`src/moments/memory.ts`）。后端的 `gist` 缺失兜底统一为 `summary.slice(0, 24)`。

## 检索与分词（bigram）

中文没有空格，**不要试图切词**。`src/memory/tokenize.ts` 对每个连续汉字片段做 2 字滑窗（bigram）枚举：

- 「你还记得我妈妈吗」→ `你还/还记/记得/得我/我妈/妈妈/妈吗`
- 真实词「妈妈」必然以某个 bigram 的形式出现 → **不会漏召回**
- 跨词边界的噪音 bigram（`你还/得我`）在库里几乎匹配不到 → 自然被淘汰

> 反例（已废弃）：贪婪取 2~6 字连续片段（`/[一-鿿]{2,6}/g`）会把长句切成「你还记得我妈」+「吗」，`LIKE` 几乎永远命中不了，检索形同虚设。

配套规则：
- 短片段（≤3 字）整体也作为一个关键词，比拆开更精确
- 关键词上限 16，超长输入**均匀抽样**（不是只留句首），避免句尾提到的东西检索不到
- **排序用「关键词重合度」**（`scoreOverlap`：命中了几个不同关键词），SQL 只做 OR 粗召回，避免命中即算数
- 片段检索时 `gist`、`summary`、`keywords` 三者都参与匹配
- **被唤起的片段**（`cuedFragmentIds`）：片段内容与当前输入的关键词重合 ≥2 个、或输入很短（关键词 ≤2）时 ≥1 个——只让真正被话题唤起的细节回到「记得很清楚」，单个 bigram 的偶然撞词（如「今天」）不算

**记忆区 Top N 只能用实时权重排序**：`active_weight` 列在建事件（`insertEvent` 传 100）与命中（`updateWeight` 传 100）时都被写成 100，全仓没有任何一处把它写低，按它排序等于不排序，会让候选集退化成「最早创建的事件」，事件数超过上限后新记忆再也进不了记忆区。灵光一闪同理：不能用 `active_weight < 40` 筛冷记忆，改成 `live_weight < COLD_MEMORY_MAX_WEIGHT`（40，冷记忆上限常量，**与详略阈值解耦**——详略阈值调高不会把温记忆抽成灵光一闪）。

## 记忆引擎行为约定（2026-10-02 重构）

**写入（巩固流）**

- **触发入口两个**：① 常规——助手回复完成且 `turn_counter` 达阈值；② 启动补巩固——聊天页挂载后静默补上次积压（`runCatchUpConsolidation`：等 chatStore persist 水合、需 API Key、模块级一次性守卫），`runConsolidation(msgs, {catchUp:true})` 从游标补到消息末尾（常规模式同样从游标补到消息末尾，触发即提取刚完成的这几轮，**不给尾部预留固定窗口**——预留会让提取落后一轮、游标滞后时退化成只提取一两条旧消息），每批一个窗口、单次启动最多 5 批，LLM 失败 / 锁被占 / 游标不推进即停，剩余积压下次启动续跑
- **时间戳沿用对话时间**：事件/片段落库 `timestamp` 取该批最后一条消息的时间（`batchEndTs`），提取提示词「## 当前时间」也用它（本地时区），避免把历史对话巩固成「今天刚发生」；`last_accessed` 仍写创建时刻（衰减从记下时起算，行为不变）
- 一次巩固可产出**多条片段**（`new_fragments` 数组，上限 5），按话题拆分；旧的单条 `new_fragment` 仍然兼容
- 每条片段带 `keywords`（2~6 个检索关键词，**要求写出同义说法**，如 `["妈妈","母亲","我妈"]`），存进 `memory_fragments.keywords`
- 新建事件前先 `findSimilarEvent()` 查语义重复（bigram 重合率 ≥0.5 或互相包含）：命中就挂靠旧事件，避免「一起玩游戏」和「玩游戏」各建一个
- `target_event_index` 指向不存在的事件 ID 时回落到兜底，不写进悬空事件

**巩固游标（不能再用数组下标）**

- 游标按**消息 id** 锚定（`last_consolidated_id` + `last_consolidated_at`），不是数组下标。
- 原因：消息会被删除（长按删单条 / 整局删除游戏卡片 / 清除数据），删除走 `.filter()`，
  后面所有下标整体左移。旧实现存 `last_consolidated_index`（下标），
  删掉**游标之前**的旧对局卡片会让中间一截对话**永久跳过、再也提取不到**
  （删游标之后的只推迟不丢，能自愈）。
- 锚点自身被删掉时退化到时间戳兜底；彻底定位不到就当「都巩固过了」——宁可少提取一次，也不要重复提取老记忆。
- 老设备的 `last_consolidated_index` 首次读到时就地转成 id 锚点。
- **窗口全是游戏回合时也要推进游标**，否则同一段对局会让巩固反复空转；LLM 提取失败则不推进，下次重试。

**衰减**

- 日常记忆按**小时**衰减，基准 `ebbinghaus_decay_rate = 0.02`（priority 5 约 1 天跌到详略阈值 60 以下开始只剩一句话、约 1.9 天跌到冷记忆线 40）。此前是 0.06/小时，15 小时就只剩一句话，体感就是「什么都记不住」
- `memory_fragments.priority` 参与分层阈值：priority ≥7 阈值 ×0.6，≤3 阈值 ×1.5。重大片段保持细节更久

**注入**

- 顺序：**检索命中的事件在前**（相关），再补高权重的「氛围记忆」，氛围记忆限量 5 条
- 命中事件注入片段时**最多 4 条**（最近 3 条 + 最早 1 条，被唤起的必保），避免一个积累几十条的事件一次撑爆预算；命中权重刷新是**事件级**（`updateWeight` 100），但渲染是**片段级**分层——「想起」只增强被唤起的那条细节
- Token 超限的截断顺序：删灵光一闪 → **低权重记忆块降级**（detail→gist，别直接删）→ 按权重从低到高删块 → 丢最旧历史
- 灵光一闪注入「事件标题 + 一句 gist」，并**优先挑与当前输入有弱关联的冷记忆**（不再是纯随机），否则 AI 只拿到标题、接不上话

**用户画像（属性/状态/事件 三桶，2026-10-10 重构）**

| 桶 | 语义 | 时效行为 |
| --- | --- | --- |
| `traits` 属性 | 永久有效的事实（喜好/性格/沟通偏好/长期目标…） | 永久注入，合并去重上限 30 |
| `states` 状态 | 有时效的近况（「[time]开始发烧」「[time]在疯狂加班」），文本带 `[time]` 占位符 | 注入时按 `created_at` 渲染成相对时间（「7天前开始发烧」）；**7 天**（`STATE_EXPIRE_DAYS`）未再被提及即停止注入（数据保留）；同一状态被重提会刷新 `created_at` |
| `events` 事件 | 有明确到期时间的约定/安排/待办（`due_time` ISO8601），即旧「约定」概念 | 生命周期见下 |

**事件生命周期与隐形提醒**（`src/memory/eventChecker.ts`，取代旧 promiseChecker 的「AI 主动发可见消息」）：

- 注入形态：**隐形提示词**拼在消息末尾（对局中不注入），AI 在下一次回复里自然提起/关心
- 到期前 **24h**：注入「事件临近」模板（`event_reminder_template`，`{{event}}`/`{{due_time}}`）
- 过期且**用户没提起**（用户消息与事件文本 bigram 实质重合，口径同「被唤起」）：注入「事件过期关心」模板（`event_care_template`），持续注入
- **用户提起** 或 关心满 **48h**（`EVENT_CARE_WINDOW_HOURS`）：归档（`archived`），同时转成一条状态（「[time]面试刚过去」）供后续关心；归档事件重新被提取到会复活为 `upcoming`

合并规则：数组合并去重、往末尾追加裁最旧（traits 30 / states 20 / events 20 / 社交 30）；状态同文本重提=刷新时效；事件同文本=更新 `due_time`。状态/事件的 `created_at` 沿用对话时间（补巩固传批末消息时间）。**旧五块画像**（preferences/psycho_state/life_quests）读到时一次性迁进三桶（存量状态打迁移时刻、存量过期事件直接进 48h 关心流程），旧键随即删除。

**尚未做**：语义重复事件只在新建时合并，历史存量未做批量去重。

## Prompt 预算与截断

- 预算 8000 token（估算：中日韩字符 ≈ 1 token/字，其余 ≈ 4 字符/token）
- 预算覆盖「系统人设 + 状态区 + 记忆区 + 历史」四段
- 超限顺序：删灵光一闪 → **低权重记忆块降级**（完整描述 → 一句话，别直接删）→ 按实时权重从低到高删记忆块（事件行连同其片段行整块移除）→ 仍超则丢弃最旧历史（至少保留最后一轮）

**默认事件「日常闲聊」**：巩固流兜底事件，LLM 可把片段挂靠其上。排除在检索与灵光一闪之外；只有当本轮**没有检索命中**时，才会把它连同最近 3 条闲聊片段补进记忆区。

## 游戏系统（4 款）

| 游戏 | 类型 | 玩法 |
| --- | --- | --- |
| 20问 | 猜谜 | AI 想谜底，用户问是非问题，20 次内猜中 |
| 数字炸弹 | 回合制 | 1~100 随机数，轮流猜缩小范围，猜中炸弹者输 |
| 快艇骰子 | 骰子对战 | 5 骰 13 轮 1v1，LLM 决策（保留骰子 / 选计分项），总分高者胜 |
| 真心话大冒险 | 陪玩 | 6 题题库（真话/冒险标签），轮流掷骰抽题、抽到啥玩啥，无胜负 |

**框架要点**：

- **对局状态**：`game_sessions.turns`（JSON）存各游戏状态机；每条聊天消息打 `game_id` 归属到对局。
- **整局框进一张卡片**：`displayItems` 把连续同 `game_id` 的消息聚成一块，`gameFrame` 用圆角边框框住「标题 + 对话」；进行中默认展开、结束折叠，顶部/底部均可收起。
- **上下文合并**：已结束对局在 `getHistory()` 里折叠成一条 `[游戏回顾]` 系统摘要（`mergeEndedGameMessages`，`role:"system"` → 发送时转 `user` 注记），不逐条挤占上下文。
- **AI 发言**：`runYachtAiTalk`（SSE 流式）；对局**结束感想**传 `gameId:null`，是普通消息、不进游戏框。
- **AI 回合真实感**：`humanDelay(min,max)` 随机延迟（思考 + 掷骰动画），模拟真人反应节奏，避免"玩家一动 AI 秒选"。

---

## 心情动态（类朋友圈，2026-10-08 上线）

| 端 | 行为 |
| --- | --- |
| 用户发帖 | 动态页右上「＋」→ 发帖浮层：心情标签单选胶囊（开心/平静/低落/烦躁/期待）+ 正文；落库 `moments` |
| AI 发帖 | 发帖计划（`post_plan`）驱动，根布局 60s 轮询执行，节奏三层真人感（见下） |
| 评论互通 | 用户评论 AI 动态 → AI 约 3~15s 随机延迟回评；AI 以概率主动评论用户动态（延迟约 30s~3min）；**无点赞**（后续迭代） |
| 记忆联动 | 双向进记忆，不等巩固流（见下） |

**导航（微信式两层）**：底部三 Tab「私藏（会话列表）/ 动态 / 设置」；一级会话列表点 AI 会话条 `router.push("/chat")` 进二级聊天页，左上「返回」回列表；聊天页原右上「设置」入口已移除，设置走底部 Tab。会话列表下方留「以后可以添加更多联系人」扩展位。

**AI 发帖真人感三层**（`src/moments/engine.ts` 的 `useMomentsEngine` 挂 `app/_layout.tsx`，任何页面都在跑）：
1. **计划层**：`generateSchedule` 一次输出 `{schedule, post_plan}`（随作息表同请求生成），每天 0~2 条、**允许整天不发**，`theme_hint` 只给主题方向；
2. **执行层**：当前时段内随机时刻触发 + 小概率临场放弃（`moment_post_skip_probability`）；
3. **放弃层**：错过时段不补发（置 `skipped`）；LLM 失败保留 `pending` 下轮重试，时段结束仍未成功即 `skipped`；深夜 0-6 点不发。

**评论互动**（`src/moments/service.ts`）：回评/主动评论均为「概率 + 随机延迟 + 失败静默放弃」；AI 评论生成期间 UI 显示「正在输入」三点动效；同一互动（momentId+replyTo）有 in-flight 防重。

**记忆联动**（`src/moments/memory.ts`，复用 `game/memory.ts` 提取范式 + `insertEpisode` 同名事件挂片段）：
- 用户发帖即记「[user]的心情动态」（即使本次无互动，AI 之后也记得用户的心情）；
- 互动闭环（AI 评论/回评落库）后追加片段：用户动态挂「[user]的心情动态」，AI 动态下互动挂「和[user]在动态下的互动」；
- AI 自身动态写「我的心情动态」，供检索时自我引用。

**配置**：模板 `moment_generation_prompt` / `moment_comment_prompt`（`schedule_generation_prompt` 已扩展输出 `post_plan` 段）；阈值见「八、配置持久化」。

---

## 六、运行状态机

```
主干：IDLE → RETRIEVING → CHAT_PENDING → CONSOLIDATING → IDLE
```

异常与降级：

- 持久化死锁：App 启动时强制 `is_locked = false`。
- 巩固超时 30s：强制解锁、丢弃本次快照，**保留轮次计数**（不 reset，下次达到阈值时重试）。
- 空库冷启动：应用 `cold_start_template` + `default_placeholders`。

---

## 七、Prompt 体系

### 消息发送顺序（勿随意调整）

```
system  : systemPrompt   系统人设（稳定）
system  : statePrompt    状态区（巩固窗口内稳定）
system  : gameSection    游戏区（对局中稳定；非对局无此段）
system  : memoryPrompt   记忆区（每次检索可能变化）
...chatHistory           历史 + 当前输入（随对话增长；已结束对局折叠为一条 [游戏回顾]）
system  : gameHint       游戏回合指令（对局中，置末就近影响本轮回复）
```

顺序意图：稳定背景（人设 / 状态 / 游戏 / 记忆）在前，让模型先掌握背景与记忆再读对话历史；游戏回合指令放最末，就近影响本轮回复。

### 模板变量

- 通用：`[user]`（用户名）、`[now]`（当前时间，如"2026年10月7日（周三）15:30"）、`[today]`（今天是：日期+周几+假期/调休语义，如"今天是2026年10月7日（周三），国庆节假期"；周末/假期/调休才带语义后缀，普通工作日省略）
- 记忆事件：`[time]`（相对时间，如"前两个月"）
- 状态区：`{{nickname}}`/`{{occupation}}`/`{{location}}`/`{{social_graph}}`/`{{traits}}`/`{{states}}`/`{{events}}`/`{{current_status}}`（三桶变量自动渲染：states 带 `[time]` 相对时间、events 带到期时间），空字段整行自动隐藏（含空段落标题）；引用旧 12 变量（`{{likes}}` 等）的存量模板自动回退到新版默认模板；`{{current_status}}` 注入的是 **AI 自己的作息状态**（如「（私藏的作息）当前：在窗边看书」），不是用户行为
- 事件提醒（隐形）：`event_reminder_template`（临近）/`event_care_template`（过期关心），`{{event}}`/`{{due_time}}`，拼在消息末尾
- 记忆区：`{{event_list}}`、`{{epiphany}}`；底部 `[today]` 时间行（日期+周几+假期/调休语义，刻意不带时刻——精确时刻由消息时间戳负责；模板没放时间变量时代码兜底追加）；历史消息里最后两条用户消息带 `[M/D 周X HH:mm]` 时间戳
- 上下文模板（`{{{system_prompt}}}` 等三花括号变量）已随「分条发送」改造彻底移除，配置里不再有 `context_template`

设置页 8 个区块均可折叠，可分别编辑：系统人设 / 上下文模板 / 状态区注入 / 记忆区注入 / 记忆事件格式，并提供变量选择器、AI 提取人设、记忆统计、数据管理。

---

## 八、配置持久化（AsyncStorage）

| 内容 | 位置 |
| --- | --- |
| API Key、Base URL、AI 名称、流式开关、思考模式、自定义主题色 | `settingsStore.ts`（AsyncStorage） |
| 聊天历史（`chat_messages`）、调试日志 | `chatStore.ts`（persist） |
| 主题模式（`theme_mode`） | `theme/useTheme.ts`（persist） |
| 提示词覆盖层 | `prompt/config.ts` |

**用户称呼不做双写**：唯一真相源是 `user_info.basic_identity.nickname`（SQLite）。`settingsStore.user_nickname` 只是内存镜像，`saveUserNickname()` 写库后同步镜像，启动时把旧的 AsyncStorage `user_nickname` 迁移进画像后即删除该 key。

**阈值配置项**（`prompt/defaultConfig.json` → `thresholds`）：
- `consolidation_window_turns`（默认 10）：累积多少轮触发一次巩固提取
- `context_history_rounds`（默认 10）：发送给模型的历史轮数，与巩固触发频率**互不影响**
- `context_active_events_limit`（默认 10）：记忆区注入的事件总数上限；其中「氛围记忆」（非检索命中的）限量 5 条，命中事件优先占位
- `detail_visible_weight`（默认 60）：详细/简略切换权重阈值，实时权重低于它的记忆只注入一句话 gist（命中事件同样降级）；调高=更多记忆变简略
- `moment_ai_comment_probability`（默认 0.6）：AI 主动评论用户动态的概率
- `moment_ai_reply_delay_ms`（默认 8000）：AI 评论/回评的随机延迟基准（±50% 抖动：回评约 3~15s，主动评论约 30s~3min）
- `moment_post_skip_probability`（默认 0.15）：AI 发帖计划的「临场放弃」概率（想发又没发）

---

## 九、相关文档

| 文件 | 说明 |
| --- | --- |
| ~~`CLAUDE.md`~~ | 已封存（2026-09-28），其流程与排期记录整体迁移至 `ARCHIVE.md`，不再使用 |
| `PRD.md` | 产品需求文档 |
| `ARCHIVE.md` | 历史版本、已完成任务、踩坑经验归档；含已封存的 CLAUDE.md 流程留档 |
| `docs/` | 设计稿（提示词编辑器重构等）+ `verification-report-p8.md`（P8 记忆引擎代码级验证报告：139 断言全过、发现与真机清单） |

---

## 十、当前进度

已完成 P1~P7（基建、数据层、记忆引擎、聊天流、巩固流、UI）与 P10/P11 系列功能；`src/version.ts` 的 `RELEASE_VERSION` 当前为 **1.0.4**（随每次 OTA 递增）。**游戏系统（4 款）已上线。**

**做梦流（P6）已下线**：原"前台闲置 180s → LLM 折叠冷事件"机制于 2026-09-29 移除，`src/memory/dreaming.ts` 及其调用、`dream_consolidation_prompt` 配置项、`getColdestEvents` / `softArchiveBatch` 查询函数一并删除。下线原因是它会物理删除被折叠事件下的全部记忆片段，并以高权重插入无片段的概括事件挤占 Top N，净收益为负。若将来重建，核心原则是让片段随事件迁移而非删除。

**近期迭代**：上线游戏系统（20问 / 数字炸弹 / 快艇骰子 / 真心话大冒险）+ 整局卡片化；已结束对局合并进上下文（一条 `[游戏回顾]`）；事件（约定）提醒改为隐形提示词注入（临近/过期由 AI 在回复里自然提起/关心，原「主动发可见消息」流程已下线）；AI 回合加人类反应延迟（`humanDelay`）；流式回复改为在目标对局框内输出（不再「框外打字 → 完成后跳进框」）；20问结束流程改为「框外庆祝提示 → 整局折叠 → 结束感想落在框外且不并入 `[游戏回顾]`」；`emotion` 列下线并并入 `summary`，记忆片段改为 `gist` / `summary` 分层存储与分层注入。并做了一轮隐患审查修复：上下文 system 角色报错、任务失败误删、渲染 key 重复、状态机卡死、退出竞态、定时器闭包过期等。

**记忆引擎一轮重构（2026-10-02）**：分词改 bigram + 重合度打分（旧版 6 字切片几乎命中不了）；修掉「记忆区 Top N 锁死在最早创建的事件」（`active_weight` 恒为 100，按它排序等于不排序）与「灵光一闪从来不触发」（筛选条件同样依赖该列）；衰减放慢（0.06/h → 0.02/h）；巩固支持一次产出多条片段并写入 `keywords` 关键词索引；新建事件前查语义重复；Token 超限改为「先降级到一句话再删块」；灵光一闪改为优先联想命中并带上 gist；画像数组加上限。**巩固游标从数组下标改为按消息 id 锚定**（删掉历史里的旧对局卡片会让中间一截对话永久丢失）。

**聊天页滚动定位（2026-10-02 修复）**：历史消息分页为「只渲染最后 `PAGE_SIZE=30` 条，滑到顶部再加载更早」。两个已知坑：
1. 定位到最新消息不能只做一次——`chatStore` 是 zustand persist，消息从 AsyncStorage **异步水合**，可能晚于首帧；气泡逐个渲染也会让 `contentSize` 继续长高。改为「只要还没定位成功、且用户没上翻历史（`atBottomRef`），每次消息数变化都重试」，并在 0/120/400ms 补滚。
2. 从列表页等处回到聊天页时屏幕可能重挂载、滚动位置回到顶部，用 `useFocusEffect` 重置「已定位」标记，重新定位一次。
3. `onStartReached` 只在「进入顶部区域」时触发一次，停在顶部不动不会再触发；顶部额外放了一个「加载更早的消息（还有 N 条）」显式入口兜底。

**P8 代码级验证完成（2026-10-05）**：用 Node + node:sqlite 内存库 + 三个 stub（expo-sqlite / AsyncStorage / openai）离线跑真实源码，P8-1/2/3 共 139 条断言全过（巩固流游标/去重/Merge 上限、灵光一闪弱关联与截断顺序、冷启动无 undefined 与消息顺序），报告见 `docs/verification-report-p8.md`。真机端到端（真实 LLM 提取质量、SSE、真机首条消息）待做；验证中发现两个轻微项待决策：记忆区事件数可为「上限+1」（默认事件 unshift 在 slice 之后）、设置页「恢复默认」按钮热区偏小。

提示词编辑器重构（P9-1）UI 已全部落地，剩真机验收与上述热区小修；`docs/prompt-editor-redesign.md` 已同步为现状（含新增的事件提醒模板（临近/过期关心）/ 时间表生成指令、已删除的做梦折叠指令）。

**心情动态 + 微信式导航（2026-10-08）**：新增心情动态（类朋友圈）——用户发帖（心情标签+正文）、AI 按随作息表生成的周发帖计划不定期发帖（三层真人感：计划可零帖日 / 时段内随机时刻+临场放弃 / 错过不补发）、评论互通（回评 3~15s、主动评论概率+30s~3min，失败静默放弃）、互动闭环双向写记忆（「[user]的心情动态」「和[user]在动态下的互动」「我的心情动态」）。导航改为微信式两层：底部三 Tab（私藏=会话列表 / 动态 / 设置），聊天页迁至 `app/chat.tsx` 二级页（左上返回，右上设置入口移除），聊天/游戏逻辑零改动；`checkAndGenerateSchedule` 加 in-flight 护栏防重复生成，`useMomentsEngine` 挂根布局全局调度。发帖计划表 `post_plan` 状态机：`pending → posted | skipped`。

**「想起」逐条分层（2026-10-09）**：命中事件不再整块擦亮——只有被当前话题**真正唤起**的片段（关键词实质重合，`cuedFragmentIds`）回到完整 `summary`，其余片段按**各自年龄**过遗忘曲线逐条决定 `summary`/`gist`；`capFragments` 必保唤起条（超额先丢未唤起且更旧的）。纯渲染层改动（retrieval 算唤起、assembler 逐条分层），数据与命中刷新机制不动。

**巩固时间正确性 + 聊天体验四项（2026-10-08）**：① 启动补巩固——聊天页挂载后 `runCatchUpConsolidation` 静默分批补上次未巩固的积压历史（一次性守卫、单次最多 5 批、失败/锁占/游标不推进即停），巩固落库与提取提示词的时间戳统一沿用**批末消息时间**，修复「几天前的对话被巩固成今天刚发生」；② 聊天列表微信式日期分隔条（间隔 ≥5 分钟或跨天显示：今天 HH:mm / 昨天 / 星期X / YYYY年M月D日），纯展示层；③ 记忆区命中片段同样按实时权重降级为一句话 gist（此前命中片段永远全文），详略阈值 40→60 并进设置可调（`detail_visible_weight`），冷记忆线拆出 `COLD_MEMORY_MAX_WEIGHT=40` 保持灵光一闪池语义不变；④ 重新生成加「收起+淡出」过渡动画（`LayoutAnimation` 220ms，动画结束后再发起重答），消除删末尾消息的布局跳变（编辑后重发的跳变按用户选择本次未处理）。
