# Jingjing — 端侧隐私型情感陪伴记忆引擎

基于 React Native (Expo) 的情感陪伴 App，核心是一套**运行在设备本地的记忆引擎**：所有对话记忆存放在端侧 SQLite，不依赖任何服务端存储，通过"短期记忆巩固 + 灵光一闪（近期动态优先，冷记忆兜底）"两条异步流模拟人类的记忆演化，让 AI 角色在时间维度上保持连贯的人格与共同经历。

---

## 〇、协作约定（务必遵守）

- **项目根目录**：本仓库即工作根目录（本机为 `d:/Jingjing`），所有命令与相对路径以此为基准，不要在其他目录另起一份副本。
- **代码注释与文档一律简洁明了**：只写结论、约定、用法和必要上下文；**禁止**写入过程试错、排错日志、调试经过、重复探查记录、失败尝试复盘等无用细节。改文档时顺手删掉这类内容，不要越写越长。
- **数字结论先给依据**：比较收益必须先写「现状花多少」再对比新方案、只认差额；频率、量级、省钱这类断言必须来自日志、脚本实测或账单，拿不到就标「未实测」。
- **改动确认后立即提交**：一处改动完成并确认、准备开始下一处时，直接 commit 并 push 当前分支，不攒未提交改动。

---

## 一、项目定位

| 项 | 说明 |
| --- | --- |
| 包名 | `jingjing`（Expo Router 入口 `expo-router/entry`） |
| 平台 | Android / iOS / Web（Expo SDK 54） |
| 存储 | 全部端侧：`expo-sqlite` 存记忆，`AsyncStorage` 存配置与聊天记录 |
| 模型 | OpenAI 兼容接口，默认 DeepSeek；三处模型路由（前台对话 / 后台巩固 / 后台检索） |

### 核心机制

- **增量补式记忆巩固**：未巩固对话攒到约 10k token、或用户停满 30 分钟且积压不少于 10 轮时触发后台 LLM 提取，把对话沉淀为「记忆事件 + 记忆片段」、增量 Merge 用户画像、更新滚动会话摘要。一次只消化一批（约一个 token 预算），剩余积压由下一个触发点继续消化；写入时间戳**沿用对话消息自身时间**（批末消息时间），不记成巩固执行时刻。
- **灵光一闪**：每次只注入一条，两条通道——① **近期动态**：概率 = 基础概率 + **最高**新近度倍数的折算 `0.02 + max(boost) × recent_moment_recall_weight`（默认权重 0.2：AI 刚发帖/被用户刚评论 4× → **0.82**，用户刚发/刚浏览 2.5× → **0.52**；好友自己发帖不计倍数；上限 0.9），命中后从近期动态事件里按 boost 抽一条、取**6 小时内最新片段**；② **冷记忆**：没有近期动态、或动态通道没掷中时按 **2%** 抽一条低活跃度冷记忆（优先弱关联）。**空输入（开场白、游戏提示）、游戏回合、重新生成都不掷**——这些轮次本就不该突然想起往事。**同一条动态只被高概率提一次**：提过即记入 `system_metadata.moment_recall_seen` 并移出候选（记录保留 24 小时，覆盖 6 小时新近度窗口），之后回落普通概率，不会「只要有近期动态就每轮灵光一闪」。
- **AI 检索判定**：每轮把未被遗忘的记忆摆成一份清单（`#id 标题 — 绝对日期 — [片段编号] 一句印象`）交给后台模型判断「这句话想起了哪些事」，输出档位（core=正在谈这件事 / related=只提到相关人物）与指认的片段编号；事件级拿不准时第二段补看最近片段再定档。无 Key、调用失败、输出非法都回落到本地关键词检索，聊天不受影响。详见「检索与判定」。
- **艾宾浩斯衰减**：记忆活跃权重随时间衰减。主路径只用它做三件事：清单排除（<15 已淡到会被遗忘）、灵光一闪冷池（<40）、兜底排序。
- **记忆分层（gist / summary）**：每条片段同时存一句话概要 `gist` 与详细描述 `summary`。主路径详略跟判定档位与指认走（正在谈的事只展开被指到的那条细节）；兜底路径按活跃度决定。详见下文的「记忆分层机制」。
- **上下文 = 会话摘要 + 未巩固对话**：已巩固部分由滚动摘要代表，游标之后才发原文；还没有摘要时全量带上（只由 token 预算兜底）。
- **AI 主动开场**：只在进入首页时判定（手机端没有可靠后台）。最后一句必须是 AI、至少隔 **2 小时**，且当天还没判定过；概率从 2 小时的 **5%** 线性升到 48 小时的 **100%**（24 小时约 50%）。**每天最多掷一次**，不中当天不再发，判定记录写在 `system_metadata.last_proactive_at`（成功失败都算）。开场前先补一条情境旁白（`[旁白]` 注记，界面上不显示），临时提示词里**写明此刻时间**（日期 + 周几 + 时分）并说明 `[旁白]` 是它自己的当下状态，不额外交代「什么时间该说什么」——开场没有用户消息可提供时刻，光靠旁白的「晚上」猜不出几点，会写出半夜刚下班这类话。内容要求像平常一样分享此刻的小事或接上次话题，一到两句即可，不追问为什么没回、不表达担心、不把短暂沉默当作出事。
- **冷启动兼容**：空库时套用冷启动模板与默认占位符，首次对话也能自然开场。

### MVP 边界

- **范围内**：本地 SQLite、AI 检索判定（全量清单两段判定 + 覆盖检查）+ 本地关键词兜底检索、衰减、会话摘要 + 未巩固历史的上下文、巩固流、冷启动降级、参数配置解耦、模型路由（前台 / 后台 / 检索判定）、游戏系统（4 款）、心情动态（类朋友圈）、AI 熟人圈（好友发帖/评论/私聊）、每日实况（习惯 × 扰动 × 用户在场）。
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

首次启动需在**设置页**填写 `API Key` 与 `Base URL`（默认 DeepSeek），配置保存在 AsyncStorage。不配置 Key 时，巩固流的后台提取会失败并累计连续失败次数（第 3 次起弹窗提醒），聊天仍可用。

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

### 评估脚本（离线，不参与打包）

```bash
npm test            # 两个都跑：检索召回 / 记忆强化时序
```

- 人工标注集就是数据文件，改用例只动 `tests/cases/`：`retrieval.cases.mjs`（输入 → 人听到会想起哪几件事）、`memories.mjs`（模拟记忆库 35 条，含同主题近邻与背景记忆，用例按 `name` 引用，写错名字会直接报错）、`weight.cases.mjs`（10 天剧情 + 每轮真正在提哪条，含两天沉默与话多的一天；剧情外的记忆作背景进检索池参与竞争）。
- 标准答案只按「人听到这句话会想起什么」定，不迁就实现；实现做不到就如实显示为失败，那正是机制与人的差距清单。
- 需要 Node ≥ 22.18（直接跑 `.ts`）；分词/门槛/打分取自真实源码，报告写到 `docs/retrieval-eval.html`、`docs/memory-weight-eval.html`。

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
  friend/[id].tsx       # 好友私聊页（第三层：会话列表 → 好友私聊）
  (tabs)/index.tsx      # 一级会话列表页（AI 会话条 + 好友区 + 最后消息预览）
  (tabs)/moments.tsx    # 心情动态页（feed / 发帖浮层 / 评论线程）
  (tabs)/settings.tsx   # 设置页（好友圈、未来事件、记忆事件详情与参数编辑）
src/
  components/           # 通用 UI：ChatBubble、InputBar、CollapsibleSection、MomentCard、MomentComposer + 游戏卡片（Bomb / YachtDice / YachtScore / TruthDare）
  db/                   # SQLite 连接、建表（schema.ts）、CRUD（queries.ts）
  moments/              # 心情动态模块：engine.ts（发帖调度）、service.ts（发帖/评论与 AI 互动）、memory.ts（动态记忆提取）、events.ts（事件标题与口语别名常量）、seen.ts（浏览记录 + 灵光一闪去重）、bus.ts（刷新总线）
  friends/              # 好友圈：persona.ts（档案/按名字命中）、roster.ts（生成/错峰登场/重建换人）、service.ts（评论）、chat.ts（私聊提示词与弱痕迹）
  game/                 # 4 款游戏：twentyQuestions（20问）/ bomb（数字炸弹）/ yacht（快艇骰子）/ truthDare（真心话大冒险），各含 engine·ai·prompt
                        # 顶层另有：memory.ts（对局记忆提取）、judge.ts（20问是非判定）、prompt.ts（游戏区 Prompt）、subjectPicker.ts（谜底选取）
  llm/
    client.ts           # OpenAI 客户端单例（API Key / Base URL 管理）
    foreground.ts       # 前台对话：SSE 流式 / 非流式
    background.ts       # 后台任务：巩固提取、作息表、每日实况、好友花名册/发帖/评论（JSON mode）
  memory/
    chatHandler.ts      # 聊天主流程编排（buildChatContext 为异步）
    retrieval.ts        # 检索主流程：闸门 → AI 判定 → 本地兜底 → 擦亮 → 灵光一闪
    judge.ts            # AI 检索判定：全量清单构建 + 两段调用 + 输出校验
    chitchat.ts         # 覆盖检查：整句只有寒暄/语法成分时跳过判定
    tokenize.ts         # 纯 JS 分词（兜底检索与覆盖检查共用 STOP_WORDS）
    decay.ts            # 艾宾浩斯衰减
    consolidation.ts    # 巩固流（token 预算/空闲触发，分批消化；跳过游戏回合与好友私聊）
    scheduler.ts        # 周基线表生成 + 当前情境查询（优先当日实况）
    week.ts             # 周/时段换算（scheduler 与 dailyLife 共用，避免循环依赖）
    dailyLife.ts        # 每日实况：生成 / 伪天气 / 深夜状态 / 近 7 天实况
    eventChecker.ts     # 未来事件（约定/离职/考试…）隐形提醒：临近/过期注入提示词，归档转状态
  prompt/
    defaultConfig.json  # 默认提示词配置
    config.ts           # 配置读写（AsyncStorage 覆盖层）
    assembler.ts        # Prompt 拼装与模板渲染
  store/
    chatStore.ts        # 聊天消息（persist）+ 调试日志（内存）
    settingsStore.ts    # API Key / 开关 / 主题色
    metaStore.ts        # 系统元数据（轮次、锁等运行时状态）
  theme/                # 浅色/深色色板（colors.ts）+ useTheme.ts
  utils/                # text.ts（splitForChat 气泡分段）、backup.ts（备份导出/导入）、holidays.ts（周几/法定节假日调休表）、motion.ts（统一入场参数与系统“减少动态效果”）、keyboard.ts（Android 键盘留白：底栏占一块缓动高度，键盘升起/收起都逐帧滑，不用 LayoutAnimation）
  types/schema.ts       # 全局类型定义
docs/                   # 评估脚本生成的报告
tests/                  # 离线评估：cases/（人工标注集，改用例只改这里）、lib/harness.mjs（从源码取真实实现）
```

---

## 五、数据模型（SQLite）

| 表 | 字段 |
| --- | --- |
| `memory_events` | `id` PK、`event_text`、`timestamp`、`active_weight`(1-100)、`last_accessed`、`priority`(1-9)、`memory_kind`(daily/episode/**condition**)、`event_status`(none/upcoming/caring/archived)、`closed_at`(ISO8601 / NULL)、`nudge_count`(已注入提醒次数，满 2 次归档)；索引 `idx_events_weight (active_weight DESC)`。**未来事件（约定、离职、考试、手术…）就是 `timestamp` 在未来的事件**：`event_status` 标记生命周期。**持续型处境（感冒、在搬家、在考研）就是 `memory_kind='condition'` 的事件**：`timestamp` 是开始时刻，`closed_at` 为 NULL 表示仍成立，写下时刻表示已结束 |
| `memory_fragments` | `id` PK、`index`（父事件 ID，**列名为 `index` 而非 `event_index`**）、`timestamp`(ISO8601)、`gist`(≤20 字一句话)、`summary`(80-120 字，**含关键细节与情绪**)、`keywords`(逗号分隔，检索用，含同义说法)、`priority`(1-9)；索引 `idx_fragments_index ("index")` |
| `system_metadata` | `key` PK、`value`；常用 key：`is_locked`、`turn_counter`、`last_consolidated_id` / `last_consolidated_at`（巩固游标，按消息 id 锚定）、`default_event_id`、`session_digest` / `session_digest_at`（滚动会话摘要）、`consolidation_fail_streak` / `consolidation_fail_reason`（连续失败次数与原因，用于告警与排查）、`moments_seen`（用户最近浏览的动态 id + 时刻，灵光一闪加权用）、`moment_recall_seen`（已提过的动态片段 id + 时刻，每条只提高概率一次）、`retrieval_fail_streak` / `retrieval_fail_reason`（AI 判定连续失败次数与原因，≥3 次设置页标红） |
| `memory_event_aliases` | `event_id`、`alias`，复合主键；事件合并后把被并事件的标题记成别名，新事件命中别名直接挂靠。索引 `idx_event_aliases_alias` |
| `user_info` | key-value 分片，只有三个键：`basic_identity`、`social_graph`、`traits`（属性桶，巩固流增量 Merge，见「用户画像」）；**用户称呼的唯一真相源**为 `basic_identity.nickname`。当前处境不在这里，它是 `memory_events` 的 condition 事件 |
| `behavior_schedule` | `id` PK、`week_start`、`day_of_week`(0-6)、`time_slot`(0-4)、`activity`、`created_at`；索引 `idx_schedule_week`。**存的是 AI 自己的作息**，用于生成当下情境（状态注记与发帖取景） |
| `game_sessions` | `id` PK、`game_type`(twenty_questions/yacht/bomb/truth_or_dare)、`mode`、`status`(playing/won/lost/abandoned)、`secret`、`secret_source`(public/memory)、`question_count`、`turns`(JSON 存各游戏状态机)、`started_at`、`ended_at`、`result_note`(结束摘要，供上下文合并) |
| `moments` | `id` PK、`author`(user/ai/**friend**)、`content`、`mood`(开心/平静/低落/烦躁/期待)、`created_at`、`friend_id`（好友发帖指向 `friend_personas.id`）；索引 `idx_moments_created`、`idx_moments_friend`。**CHECK 只在建表时写死，旧库靠重建表扩展**（`migrateSocialSchema`） |
| `moment_comments` | `id` PK、`moment_id`、`author`(user/ai/friend)、`content`、`created_at`、`friend_id`；索引 `idx_comments_moment` |
| `post_plan` | `id` PK、`week_start`、`day_of_week`(0-6)、`time_slot`(0-4)、`theme_hint`、`status`(pending/posted/skipped)、`created_at`、`author`(ai/friend)、`friend_id`；索引 `idx_post_plan_week`。**发帖计划**：AI 的随作息表同一请求生成（本周缺 AI 计划时单独补一份），好友的按日掷骰后插入 |
| `daily_log` | `day` PK(YYYY-MM-DD)、`slots`(JSON 5 格，空串=留白)、`mood`、`highlight`(今日主线)、`late_night`(当天 0-6 点状态)、`weather`(按日期种子伪天气)、`created_at`、`updated_at`。**当日实况**，只读不回写 |
| `friend_personas` | `id` PK、`name`、`avatar_emoji`、`summary`(一句关系与态度)、`profile`(自由文本小传，按 `[身份]/[说话方式]/[与[user]的关系]/[你对他们俩的看法]/[你自己的日子]` 分段)、`is_active`、`is_deleted`(删除只让人消失，历史动态仍能署名)、`debut_at`(错峰登场时刻)、`created_at` |
| `retrieval_logs` | `id` PK、`created_at`、`user_text`、`stage1_output`、`stage2_output`(未触发为 NULL)、`final_injected`(最终注入的事件编号 JSON)、`fallback`(1=本地兜底接管)、`event_count`(清单条数)、`expand_used`、`latency_ms`；索引 `idx_retrieval_logs_created`。**AI 判定记录**：只留最近 5000 条，供复盘与反哺 `tests/cases/` |

时段编码：`0=早(6-9) 1=上午(9-12) 2=午(12-15) 3=下午(15-18) 4=晚(18-23)`，0-6 点为深夜特殊处理（按日期种子取「失眠/被叫醒/做怪梦」等状态，同一晚保持一致）。

> 所有 SELECT 都走显式列名（`EVENT_COLUMNS`），不依赖 `SELECT *`——加列时不用改读取点。
>
> 备份导出/导入覆盖全部表（含 `retrieval_logs`）：导入先清空再逐条写入、id 原样恢复；「清除所有数据」同样清判定记录。

## 记忆分层机制（gist / summary）

每条记忆片段写两遍：一句留给「快忘了」的时候，一段留给「还记得」的时候。

| 字段 | 规格 | 用途 |
| --- | --- | --- |
| `gist` | ≤20 字一句话，含 `[user]` `[time]` | 记忆变淡后只剩的印象 |
| `summary` | 80~120 字，含 `[user]` `[time]`，写清「发生了什么 + 关键细节 + 当时情绪」 | 想起来时的完整细节 |

**渲染规则**（`assembler.ts` 的 `buildMemorySection`）——像人的「想起」**逐条**分层，想起一件事不把整段往事全部擦亮：

| 情况 | 注入内容 |
| --- | --- |
| 判定 core + 指认了片段 | 指认那条给完整 `summary`，同事件其余给一行 `gist`（合计 ≤4 条） |
| 判定 core + 没指认 | 最近一条给 `summary`，其余一行 `gist` |
| 判定 related | 只一行：事件标题 + 一句 `gist` |
| 兜底路径（AI 判定不可用） | 被当前输入唤起的片段给 `summary`，其余按片段自身年龄过遗忘曲线 |

命中事件最多注入 4 条片段。主路径**不再读年龄曲线与 `detail_visible_weight`**，那个阈值只在兜底路径生效（设置页「记忆流转阈值」已注明）；`cuedFragmentIds` 同样只在兜底路径参与详略。兜底路径的详略阈值 = `detail_visible_weight`（默认 **60**；调高=更多记忆变简略）× priority 系数（见「记忆引擎行为约定·衰减」）。

`gist` 为空时（老数据、手动新增未填）回退为 `summary` 前 24 字，保证分层渲染永远有内容。

**每行带相对日期**（`anchorLine`）：片段行 / 好友记忆行 / 灵光一闪都以 `3天前 ` 开头。文本自带 `[time]` 时由占位符渲染出相对时间、不再加前缀；`gist`、老数据、模型漏写 `[time]` 的由代码补齐——只有「晚上」「下午」这类时段词，模型看不出事件先后。

**写入方**：巩固流（`background.ts` 提取指令）、游戏记忆（`memory.ts`）、20问（`twentyQuestions.ts`）、四款游戏的 `insertEpisode` 调用点（`chat.tsx`）、心情动态记忆（`src/moments/memory.ts`）。后端的 `gist` 缺失兜底统一为 `summary.slice(0, 24)`。模型写的正文统一过 `normalizeMemoryText`（`memory/identity.ts`）：写死的日期换回 `[time]`、正文里的真实称呼换回 `[user]`/`[ai]`——名字写死会让改名后记忆里的说法不跟着变，也会让判定清单整份换字样、前缀缓存全废。

## 检索与判定

**主路径是 AI 判定**（`judge.ts` + `retrieval.ts`），本地关键词检索只剩兜底与灵光一闪。

### 覆盖检查（省的是延迟，不是钱）

判定前归一化（去空白、标点、emoji），用 `tokenize.ts` 的 `STOP_WORDS` 做最长匹配：整句每个片段都被表吃掉（`早上好`、`今天几号`、`今天天气怎么样`、`嗯嗯好的`）→ 当轮零事件、不调 AI；吃到一半断掉（`好的妈妈`、`早上好我今天头疼`、`今天几号考试来着`）→ 照判。表一张两用（检索停用词 + 覆盖词），**绝不收情感词、身体状态、具名事物、动作**：它们是想起往事的那根线。游戏里的是非回应（猜对/答错/差不多）也收进来了——它们同样不指向任何往事，却会让每问一次都白调一次判定。空输入（游戏回合、开局）同样跳过。

词表还叠加上用户配置的「检索屏蔽词」（默认是双方称呼）：这些词**按停用词处理**——整句只有它们时同样跳过判定，兜底检索也不拿它们当关键词；不改记忆内容，也不进判定请求。

### 全量清单

- 范围：`memory_events` 全库，排除 `upcoming`、默认事件、**实时权重 <15**（`decay.ts` 现算，不建定时任务）。只有 **priority ≥7** 的事件有 15 的权重下限（永远在清单里）；1-6 级没有下限——1~3 级 0.9~3 天内淡出，4~6 级 5.7~20 天淡出。衰减不看记忆类型
- 排序：**id 升序**（前缀缓存的前提：新事件天然追加尾部，老前缀不变）
- 每行：`#37 那次面馆探店 — 11月2日 — [f91] 加班后去吃了牛肉面 — [f88] 第一次去排了半小时队`，只摆**最近 1 + 最早 1** 条片段并标出编号——编号是 AI 指认细节的唯一依据
- 渲染：`[time]` → **绝对日期**（相对时间每天变，会把缓存打爆）、`[user]` → 「用户」、`[ai]` → 「你」（不渲染真实昵称：昵称可改、真名对判定没有信息增量）
- 请求顺序锁死：`[system] 判定说明` → `[user] 全量清单` → `[user] 今天日期 + 用户这句话`；第二段把展开块并进最后一条，前缀完全不变

### 判定与兜底

- 判定走 `getModelRouting().retrieval_judge_config`（设置页「模型路由 → 后台检索模型」，默认与后台巩固相同），JSON mode、温度 0
- 第一段输出 `{"hits":[{"id":88,"level":"core","frag":91}],"expand":[37]}`；`hits` ≤6、`expand` ≤5，超限按 core 优先截断
- 程序守规矩：`level` 非法按 related、id 不存在丢弃、`frag` 不在可选池里就丢这个字段（事件仍注入）、JSON 取第一个 `{...}` 再解析。可选池第一段是清单展示的两条，第二段是清单两条 ∪ 本次展开的片段——**看过的细节才能被指认**
- 第二段只为 `expand` 里的事件补看最近 ≤8 条片段再定档，结果覆盖第一段；第二段失败用第一段结果
- **解析失败 / 请求失败 ≠ 零命中**：一律走兜底并记 `fallback=1`，绝不返回空（否则静默丢召回，还连带丢掉擦亮）；不重试。单段超时 5s
- **清单为空不调用**（新装、清空数据后还没攒下记忆）：零事件，不写日志、不计失败、也不跑兜底，避免白花请求还被记成 Key 故障
- 清单排除**一条片段都没有的孤立事件**（判中了也渲染不出内容）、已结束的处境在日期后标 `（已结束）`
- **同一句话 30 分钟内复用上次判定**：重新生成 / 编辑重发不再付第二次钱
- **拼清单或判定抛异常也走兜底**，不让异常冒到聊天流程把这一轮回复弄没
- 兜底 = 下面这套 bigram 检索，候选池同样排除 <15（口径与主路径一致）
- 每轮判定写 `retrieval_logs`（原话、两段原始输出、最终注入、是否兜底、耗时），上限 5000 条滚动清理；被闸门拦下、清单为空的轮次不写
- 连续失败 ≥3 次在设置页「AI 检索判定」下标红字（不弹窗），`retrieval_fail_streak` 成功一次清零
- 擦亮二值：判 core/related 即 `active_weight=100` + `last_accessed=now`；未选中不擦不注

### 兜底检索（bigram）

中文没有空格，**不要试图切词**。`src/memory/tokenize.ts` 对每个连续汉字片段做 2 字滑窗（bigram）枚举：

- 「你还记得我妈妈吗」→ `你还/还记/记得/得我/我妈/妈妈/妈吗`
- 真实词「妈妈」必然以某个 bigram 的形式出现 → **不会漏召回**
- 跨词边界的噪音 bigram（`你还/得我`）在库里几乎匹配不到 → 自然被淘汰

配套规则（只在兜底路径生效）：
- 短片段（≤3 字）整体也作为一个关键词，比拆开更精确
- **长句按标点拆段**：每段独立提词检索再按得分合并，实体词落在句中不靠「关键词抽样」的运气（关键词上限 16 的均匀抽样只在段内起作用）
- **排序用「IDF 加权重合度」**：分数 = 命中关键词的 IDF 之和（df 按标题/别名/印象/标签逐词 COUNT，本地量级代价可忽略），通用词（周末、心情）带分少、独一份的词带分多；SQL 只做 OR 粗召回
- **相对截断 50%**：加权分低于段内最高分一半的候选丢弃，防通用词把不相干往事顶进 Top3（拆段后各话题独立成段，不会互相截掉）
- **命中门槛**：**命中 1 个关键词即入候选**，不按关键词总数分档——「有点想家」这类三字短句必然夹跨词噪音 bigram（「点想」），要求「关键词少就全中」会把整句否掉，而「想家」明明在三条记忆的标签里。噪音改由 IDF 加权（常见词分低）与相对截断 50% 挡住。只有达标命中才写库刷权重、擦亮片段，故门槛同时是副作用的总开关
- **两条召回通道合并**：标题/别名命中与片段命中**一起排序取 Top3**——否则一句话提三件事时（「压力大，团子还生病了」），一个弱标题命中会把另外两件吃掉
- **同分按 last_accessed 排**：引擎只把 active_weight 写成 100，按它排等于按创建顺序（新记忆永远吃亏），改按更近被想起过的事件优先
- 片段参与比对只用 `gist`（一句话印象）+ `keywords`（写入时抽的标签），`summary` 只用于渲染：完整叙述拿「有点 / 觉得 / 一个人」这类虚词一撞就中（「地铁上有人吵架」撞进「和小陈吵架」）
- **单字兜底**（`singleCharKeywords`）：常规关键词一个都没命中时，才用输入里的单字再找一次，且只认「标签里恰好有一个单字标签」（标签写「猫」才匹配「猫」，写「吃面」不会被单字「吃」命中）。这一步专为「猫」这类单字实体存在——bigram 切不出单字，否则永远检索不到
- **事件检索也匹配别名**：合并过的事件把旧标题存进 `memory_event_aliases`，事件层按「标题或别名」粗召回，打分文本也拼上别名（只命中别名的候选否则会被命中门槛过滤掉）
- **动态事件带口语别名**：三个动态事件（`[user]的心情动态` / `我的心情动态` / `朋友圈日常`）共用别名「朋友圈」「动态」「帖子」（`moments/events.ts` 的 `MOMENT_EVENT_ALIASES`），用户换哪种说法都能召回；别名在每次写入动态记忆时一并补写
- **被唤起的片段**（`cuedFragmentIds`，仅兜底路径）：片段内容与当前输入的关键词重合 ≥2 个、或输入很短（关键词 ≤2）时 ≥1 个——只让真正被话题唤起的细节回到「记得很清楚」，单个 bigram 的偶然撞词（如「今天」）不算
- **命中可追溯**：兜底命中时「检索」日志逐条写出「哪个关键词 → 撞上哪条事件的标题 / 别名 / 印象 / 标签」，归因与打分文本同源；单字兜底命中时改用单字口径

**冷记忆池只能用实时权重筛**：`active_weight` 在建事件与命中时都被写成 100，引擎不会主动写低（设置页可手改，下次命中又刷回 100），拿它筛等于不筛。灵光一闪用 `live_weight < COLD_MEMORY_MAX_WEIGHT`（40，**与详略阈值解耦**——详略阈值调高不会把温记忆抽成灵光一闪）。

## 记忆引擎行为约定（2026-10-02 重构）

**写入（巩固流）**

- **触发条件**：未巩固对话累计 ≥ `consolidation_token_budget`（默认 10k token），或距上次巩固 ≥ `consolidation_idle_minutes`（默认 30 分钟）；且不少于最小窗口（`consolidation_window_turns` × 2 条）。`turn_counter` 仍自增但不再参与判定
- **检查点只有三个事件**：助手回复完成、用户发消息、App 回到前台——不依赖后台常驻或定时器（手机端后台不可靠）
- **请求结构**：`[system] 提取规则 + 输出格式`（固定，可命中前缀缓存）→ `[history] 游标之后的新对话`（只发增量，按 30 分钟断开分段、段首标一次时刻）→ `[user] 当前时间 / 已有数据 / 上次摘要 / 候选事件 / 任务`（动态，放最后）
- **历史时刻标签**：相邻消息断开 ≥30 分钟才另起一段；段首写 `[HH:mm]`，与批末消息不同天写 `[M/D HH:mm]`。标签是写死的绝对时间（重试不变），只供模型判断先后与间隔，片段仍写 `[time]` 占位符
- **候选事件**：三个来源——片段内容、事件标题、**别名**（合并过的旧标题）——取 3~5 个，每个给标题 + 最早 1 条 + 最近 2 条片段，**片段保持原文（含 `[time]`/`[user]` 占位符，绝不渲染成「3天前 …」）**：那样等于给模型示范把相对时间写死进记忆，而写死的「3天前」过一周还是 3 天前；默认事件仅作为兜底候选追加
- **分批消化**：每次触发只处理游标之后、约一个 token 预算的对话；积压长时由后续触发点续跑，没有单独的补巩固入口
- **末尾未定稿的一轮不提取**（`unsettledTailStart`）：最后一条助手回复可能被「重新生成」替换，它配对的用户消息可能被「编辑后重发」连带删除，巩固进去就记下用户实际没留下的版本。窗口从游标补到「已定稿的末尾」，这一轮等它不再是末尾（有新对话）才提取；但**不能按窗口大小从尾部对齐**（`len-windowSize`）——那会让游标滞后时只圈到一两条旧消息
- **时间戳沿用对话时间**：事件/片段落库 `timestamp` 取该批最后一条消息的时间（`batchEndTs`），提取提示词「## 当前时间」也用它（本地时区），避免把历史对话巩固成「今天刚发生」；`last_accessed` 仍写创建时刻（衰减从记下时起算，行为不变）
- 一次巩固可产出**多条片段**（`new_fragments` 数组，上限 8），按话题拆分
- **没有信息量的内容不产出片段**：寒暄、问候、道别、纯应答、表情、流水账都跳过（整批只有这类内容时返回空数组）。每天重复的仪式（道晚安、打招呼）不是一件件经历——确有意义的只留一条（标题写习惯本身，如「每晚的睡前道别」）并沿用，不要每批新建；零碎无主题的日常明确挂「日常闲聊」。**闸门只在提示词里**，代码不做关键词/长度这类机械判定
- 片段可带 **`happens_at`**（将来才发生的事：约定、离职、考试、手术、搬家…）：独立成一条 `memory_events`（`timestamp = happens_at`、`event_status = upcoming`），不挂到已发生的事件上；同一件事重复提取走 `upsertFutureEvent` 更新时刻，不新建。标题会去掉开头的时间词（「下周三下午面试」→「面试」），避免过期后标题里的时间变成错误信息
- **事件归并**：模型输出 `event_merges: [{keep, merge:[id], reason}]`，判断「这几条事件其实是同一段经历」；写库先归并（事务）再写片段，`target_event_index` 指向被合并 id 时按 `idMap` 重定向。合并后片段改挂 keep、priority/weight 取大、timestamp 取早，被并事件的标题写进 `memory_event_aliases`，之后新事件命中别名直接挂靠（同一判断不重复做）；`findSimilarEvent` 的 bigram 合并仅作漏判兜底
- **会话摘要**：同一次调用产出 `session_digest`（200~300 字，旧摘要 + 本批对话滚动压缩，最近具体/更早结论），存 `system_metadata`；时间写绝对日期（近的到日、更早的到月），不用 `[time]`——摘要横跨多件事，没有单一时间戳可渲染；`[user]`/`[ai]` 保留占位符，注入时才替换；**注入时另把完整日期换算成相对说法**（`renderDigestDates`，只作用于摘要条）：`26年11月14日` → `昨天 / 3天前 / 上周 / 5天后`，只写月份的 `26年11月` 与不带年份的日期不动，库里原文不改写，否则滚动压缩会把相对时间写死。空值或失败不覆盖旧摘要；允许「只有摘要、没有片段」的返回
- 每条片段带 `keywords`（2~6 个检索词，**写「用户以后可能怎么提起这件事」**：口语说法、同义说法、当时的情绪，如 `["妈妈","我妈","想家","番茄炒蛋"]`；至少一个是能区分这件事的实体或事件词，别让「工作」「生活」这类词当唯一标签），存进 `memory_fragments.keywords`
- **能不能被忘掉只看优先级**：衰减速度以 6 级 20 天跌到遗忘线为锚，每差一级快/慢 1.88 倍，全部随基准等比缩放；7 级以上保留 15 分下限。`daily`/`episode`/`condition` 不参与衰减判断，模型本来就每条都输出 priority，不需要额外的类型字段。零碎到没有主题的日常仍然挂默认事件「日常闲聊」
- **又聊到同一件事就把权重刷回满分**：片段写进已有事件后 `updateWeight(target, 100)`（默认事件除外，它不参与检索）。否则已经淡出遗忘线的旧事件会一直被追加片段、却永远检索不到
- 新建事件前先 `findSimilarEvent()` 查语义重复（bigram 重合率 ≥0.5 或互相包含）：命中就挂靠旧事件，避免「一起玩游戏」和「玩游戏」各建一个
- `target_event_index` 指向不存在的事件 ID 时回落到兜底，不写进悬空事件
- **失败不推进游标 + 必须告警**：提取失败（`extractConsolidation` 返回 `{ ok:false, reason }`）或写库异常时游标原地不动，积压留着下次重试；连续失败计入 `consolidation_fail_streak`，第 **3** 次、之后每 **10** 次弹窗（带失败原因与积压条数），成功一次清零。未巩固对话既不裁也不删，所以这个弹窗是用户唯一能察觉「记忆一直没写进去」的出口

**巩固游标（不能再用数组下标）**

- 游标按**消息 id** 锚定（`last_consolidated_id` + `last_consolidated_at`），不是数组下标。
- 原因：消息会被删除（长按删单条 / 整局删除游戏卡片 / 清除数据），删除走 `.filter()`，
  后面所有下标整体左移。用下标做游标时，删掉**游标之前**的旧对局卡片会让中间一截对话
  **永久跳过、再也提取不到**（删游标之后的只推迟不丢）。
- 锚点自身被删掉时退化到时间戳兜底；彻底定位不到就当「都巩固过了」——宁可少提取一次，也不要重复提取老记忆。
- **窗口全是游戏回合时也要推进游标**，否则同一段对局会让巩固反复空转；LLM 提取失败则不推进，下次重试。

**衰减**

- 遗忘速度只看优先级，所有档位随基准 `ebbinghaus_decay_rate`（默认 0.02）**等比缩放**：6 级在基准下约 20 天跌到遗忘线（15 分），每差一级快/慢 1.88 倍（3 级约 3 天、4 级 5.7 天、5 级 10.6 天、7 级 37.6 天、9 级 133 天）；基准翻倍则各档天数减半
- **15 分下限只给 7 级及以上**（永不彻底遗忘）；1-6 级没有下限，能一路跌到 1
- **遗忘线 15**：实时权重跌破 15 的事件不进判定清单，兜底候选池也不召回；它仍可能被灵光一闪抽到（冷池 <40），命中擦亮回 100 后重新进清单——遗忘是降级不是死刑
- **擦亮二值**：判定选中（core/related）与灵光一闪命中都写 `active_weight=100` + `last_accessed=now`，没有中间档；未选中不擦不注
- `memory_fragments.priority` 参与兜底路径的分层阈值：priority ≥7 阈值 ×0.6，≤3 阈值 ×1.5（重大片段保持细节更久）

**注入**

- **记忆区只给本轮判定/兜底选中的事件**（「还有别的共同经历」由会话摘要与灵光一闪承担）；**没有命中时整块不出现**
- 命中事件注入片段时**最多 4 条**，避免一个积累几十条的事件一次撑爆预算；主路径是「指认的那条给完整段落 + 其余一行」，兜底路径是「最近 3 条 + 最早 1 条，被唤起的必保」。命中权重刷新是**事件级**（`updateWeight` 100），渲染是**片段级**分层——「想起」只增强被指认/被唤起的那条细节
- **记忆区模板**（`memory_injection_template`）：默认只有「你想起了：」+ `{{event_list}}` / `{{epiphany}}`，不带机制说明；事件标题不显示，只给片段行（本身带相对日期与细节）
- Token 超限的截断顺序：删灵光一闪 → **低权重记忆块降级**（detail→gist，别直接删）→ 按权重从低到高删块 → 丢最旧历史
- 灵光一闪只给一句印象，不带事件标题与「灵光一闪」「冷记忆」这类机制标签；记忆区里没有占位文案，空就空着。**排除集是本轮已注入的事件**（主路径取 AI 选中、兜底取本地命中的那些），命中后同样擦亮回 100。**近期动态优先**：`retrieval.ts` 的 `recentMomentBoost` 算出 6 小时内各动态事件的新近度（AI 刚发/被用户刚评论 4×、用户刚发/60 分钟内刚浏览 2.5×；好友自己发帖不计），概率 = `0.02 + 最高倍数 × recent_moment_recall_weight`（多条同时新鲜不叠加，上限 0.9）——**先掷这一枪**，命中就取该事件 6 小时内最新片段（动态刚写进库、实时权重高，正常进不了冷池，但刚发的帖子正该被想起）；没命中才轮到 2% 的冷记忆。**空输入、游戏回合、重新生成整轮不掷**（`retrieve` 的 `skipEpiphany`）。**每条动态只走一次高概率通道**（提过即移出候选），所以「刚发过动态」不会变成每轮都在灵光一闪

**用户画像（属性桶 + 当前处境）**

| 桶 | 语义 | 时效行为 |
| --- | --- | --- |
| `traits` 属性 | 永久有效的事实（喜好/性格/沟通偏好/长期目标…） | 永久注入，合并去重上限 30 |
| `condition` 处境 | 仍在持续的处境（感冒、在搬家、在考研）。它是 `memory_events` 里的一类事件，不是画像字段 | 每轮注入状态区；超过「耐心期限」未再提及只加一句「可能已经过去了」（priority ≥7 → 21 天，≤3 → 4 天，其余 7 天），不删数据；用户说「好了」写 `closed_at` 结束 |

**处境的写入与生命周期**（`queries.ts` 的 `getActiveConditions` / `startCondition` / `resolveCondition`）：

- 巩固流不再输出 `new_info.states`：片段带 `condition`（标签）表示「仍在持续」、带 `condition_ended` 表示「结束了」，代码据此新建/刷新/闭合，**叙述只写一份在片段里**
- 同名处境只复用 `closed_at IS NULL` 的那条：上次感冒结束后再感冒会新开一条，两次都留得住，靠关键词检索想起上一次
- 闭合只写 `closed_at`，事件留在表里继续参与衰减与检索（衰减看优先级，跟普通经历一样）；设置页删掉一条处境等于结束它
- 事件归并时处境语义不丢：任一方是 condition 则合并结果仍是 condition，只要有一条未结束就仍是进行中
- 仍在持续的处境已在状态区出现，记忆区只在检索真正命中它时补细节；已结束的处境在首行片段标「（已经过去了）」

未来事件（旧「事件桶」）已并入 `memory_events`：巩固时片段带 `happens_at` → 事件 `timestamp = happens_at`、`event_status = upcoming`；同一件事重复提取走 `upsertFutureEvent` 更新时刻，不新建。不限于约定——离职、考试、手术这类重大节点同样走这条链路。

**未来事件生命周期与隐形提醒**（`src/memory/eventChecker.ts`，数据源为 `memory_events` 的 upcoming/caring）：

- 注入形态：**隐形提示词**拼在消息末尾（对局中不注入），AI 在下一次回复里自然提起/关心
- 提醒总共 **2 次**（`nudge_count` 计数，`MAX_NUDGES`），用完即归档——不靠「用户是否提起」收敛（那个 bigram 判定很难命中）
- 第 1 次：到点前 **24h** 内，注入「未来事件临近」模板（`event_reminder_template`，`{{event}}`/`{{due_time}}`），同一阶段只提一次
- 第 2 次：过期后 **48h** 内（`EVENT_CARE_WINDOW_HOURS`），注入「未来事件过期关心」模板（`event_care_template`）；次数用完或窗口到期即归档
- **用户自己提起**（用户消息与事件文本 bigram 实质重合，口径同「被唤起」）→ 提前归档
- 归档 = `event_status='archived'`，事件留在记忆里继续参与检索与衰减。**已归档的事件被重复提取不会复活**（文本命中且发生时刻没变）；只有时刻真的变了（改期）才复活为 `upcoming` 并把 `nudge_count` 清零

合并规则：`traits` 去重追加、保留最新 30 条，社交图谱按名字覆盖后保留 30 条；未来事件同文本=更新发生时刻（`upsertFutureEvent`；已归档且时刻没变则保持归档，时刻变了才复活并重置提醒次数）。**旧五块画像与 `states` 键一律不读**（处境已并入 `memory_events`）。

**尚未做**：语义重复事件只在新建时合并，历史存量未做批量去重。

## 前台上下文构成（缓存友好，2026-11-12）

消息顺序：`[system 人设] → [system 今天] → [system 状态区（用户侧）] → [user 会话摘要 + 未巩固历史（含状态注记）] → [system 游戏区] → [system 记忆区] → 游戏提示 → 事件提醒`。

- **AI 的情境走历史注记**：用户开口且当下情境变了时，在该条用户消息之前插入一条 `is_state_note` 用户消息（`[旁白] …`，不带时刻），界面不显示；它随历史进上下文与巩固提取，不占缓存前缀。`getHistory()` 会补回被巩固游标切掉的最近两条注记；删除触发它的用户消息时一并移除。**旁白是第三人称**：格式为「上一格。刚刚，此刻」，如「下午，静静在常去的咖啡馆改稿。刚刚，静静在窗边看书。」。主语和指代由生成端一次写出（activity 以 `[ai]` 开头、提到用户写 `[user]`），代码只加时段、渲染名字，**不补主语**——缺主语就是生成端违约，宁缺勿猜；「你」是给模型的称呼，正文里出现就会和用户的名字撞车（「你给哥哥打字…烦到你」），残留的一律按用户处理。上一格只取同一段今天里紧邻的那一格：留白、与当前相同、或**已经存在于当前上下文**（`isPrevSeen` 比对 `getHistory()` 里的旁白）时都不再重复写
- **历史只带游标之后的原文**：`getHistory()` 读 `last_consolidated_id`，已巩固部分由 `session_digest` 代表（`assemblePrompt` 插在历史最前，带 `is_digest` 标记）。**历史不做任何截断**：既不按轮数切窗口，也不因超预算掉队——这段对话还没进记忆，丢了就永远丢了；按窗口从头切还会让下一次请求的开头整体左移，前缀缓存全废
- **没有摘要时全量带上**：游标还不存在，截任何窗口都是每轮换一次开头。冷启动（还没有用户画像，不走预算测量）与好友私聊才用 `context_history_rounds` 的窗口
- **记忆区/游戏区后置**：它们随话题变化，放在历史前会让后面整段历史的前缀缓存失效；记忆区只在命中时出现（未命中整块不出现，连这 1200 token 都不付）
- **摘要换代**：每次巩固后摘要变化 → 下一次请求前缀分叉一次（约每 10k token 一次），属于设计内开销
- **命中率可观测**：每次请求后打印「用量」日志（`foreground.ts`，流式靠 `stream_options.include_usage`），调试弹窗顶部常显最近一次的缓存命中率，巩固检查日志同一行也附带——用来验证前缀有没有被意外改动
- **调试日志**：只留最近 100 条、不持久化；单条超过 500 字先在列表里显示前 500 字，点「查看全文」在覆盖层看完整内容（覆盖层不改变列表排版与滚动位置）。打开面板时定位到最后一条，**之后来新日志不再自动滚动**，避免抢走正在看的位置。AI 检索判定每次调用写两条：「检索判定请求」（实际发出去的三段：说明 / 全量清单 / 今天与用户，二段只记被替换的那条）与「检索判定返回」（模型原始 JSON，解析失败也照记），外加一条「检索判定用量」（prompt / 命中缓存 / 输出），用来确认前缀缓存是否真的命中

## Prompt 预算与截断

- 预算 `context_token_budget`（默认 18000 token；估算：中日韩字符 ≈ 1 token/字，其余 ≈ 4 字符/token）。未巩固历史最多可到 10k，预算要尽量装下「10k + 人设 + 状态区 + 记忆区」
- 预算覆盖「系统人设 + 日期 + 状态区 + 会话摘要 + 历史 + 记忆区」全部段，但**只压记忆区**
- 超限顺序：删灵光一闪 → **低权重记忆块降级**（完整描述 → 一句话，别直接删）→ 按实时权重从低到高删记忆块（事件行连同其片段行整块移除）→ **到此为止**
- **历史一条都不删**：上下文里的历史全是游标之后还没巩固的对话，删掉这段经历就永远进不了记忆（已巩固的部分本来由摘要代表，不在历史里）。真装不下就让这次请求超一点，超出量写进日志
- **裁剪要留痕**：`assemblePrompt` 返回 `trimmed`（降级几块 / 删几块记忆 / 仍超多少 token），由 `chatHandler` 打进「上下文」日志

**默认事件「日常闲聊」**：巩固流兜底事件，LLM 可把没有明确主题的碎片挂靠其上。排除在检索与灵光一闪之外，**也不再在未命中时补进记忆区**。

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
| 评论互通 | 用户评论 AI 动态 → AI 约 3~15s 随机延迟回评；AI 以概率主动评论用户动态（延迟约 30s~3min）；好友各自独立掷骰决定「谁刷到」，再由模型决定谁开口（0~N 人）；**无点赞**（后续迭代） |
| 进私聊 | 点好友动态的头像/署名、或好友评论 → 进 `/friend/[id]` 私聊；长按仍是「不再让 ta 出现」 |
| 记忆联动 | 双向进记忆，不等巩固流（见下） |

**导航（微信式两层）**：底部三 Tab「私藏（会话列表）/ 动态 / 设置」；一级会话列表点 AI 会话条 `router.push("/chat")` 进二级聊天页，左上「返回」回列表；聊天页原右上「设置」入口已移除，设置走底部 Tab。会话列表下方留「以后可以添加更多联系人」扩展位。

**AI 发帖真人感三层**（`src/moments/engine.ts` 的 `useMomentsEngine` 挂 `app/_layout.tsx`，任何页面都在跑）：
1. **计划层**：`generateSchedule` 一次输出 `{schedule, post_plan}`（随作息表同请求生成），一周 2~5 条、每天 0~2 条、**允许整天不发**，`theme_hint` 只给主题方向。时段只用 **1~4**（早 6-9 点与深夜不发，与 `getDefaultPostPlan` 一致；执行层只拦深夜，不拦 slot 0）。**作息表与计划分开判定**（`hasScheduleForWeek` / `hasPostPlanForWeek`）：本周有表但没有 AI 计划（旧版本生成、或计划排在了已过去的日子）时补一份计划，只保留**还没过去**的日子与时段，并保证今天有一条；
2. **执行层**：当前时段内随机时刻触发 + 小概率临场放弃（`moment_post_skip_probability`）；
3. **放弃层**：错过时段不补发（置 `skipped`）；LLM 失败保留 `pending` 下轮重试，时段结束仍未成功即 `skipped`；深夜 0-6 点不发。

**发帖素材**（`postFromPlan`，模板 `moment_generation_prompt`）：人设 + AI 当前情境（`formatScene`）+ 计划里的 `theme_hint` + **最近 3 天最多 3 件共同经历**（`getRecentSharedEvents`，`{{memories}}`：只给事件标题 + 最新一句 `gist`，排除约定 / 处境 / 三个动态自身事件，避免自我引用）+ 最近 5 条动态（防重复）。模板要求只保留两条（字数与口语化、不出现产品词 / 不自称 AI），心情标签的取值范围写在输出格式那一行；共同经历那段只是素材，没有「别复述细节」的硬约束——想收紧就自己在模板里加一条。

**随帖生成好友留言**：发帖前先对每位已登场好友独立掷骰（`pickSeenFriends`），只有**刷到这条动态的人**（名字 + 一句关系 + 小传片段）进 `{{friends}}`；模型在同一次请求里判断这些人谁开口、写 0~N 条 `friend_comments`，代码按名字匹配（对不上就丢、一人一条），帖子落库后按延迟插入 `moment_comments`——内容是现成的，延迟只决定「什么时候出现在评论区」。

**评论互动**（`src/moments/service.ts`）：回评/主动评论均为「概率 + 随机延迟 + 失败静默放弃」；AI 评论生成期间 UI 显示「正在输入」三点动效；同一互动（momentId+replyTo）有 in-flight 防重。好友评论在同一套范式上旁挂（见「好友圈」）。刷新走 `src/moments/bus.ts`（单独成文件是为了断开 service ↔ friends/service 的循环依赖）。

**记忆联动**（`src/moments/memory.ts`，复用 `game/memory.ts` 提取范式 + `insertEpisode` 同名事件挂片段）：
- 事件**按帖子作者**归一个（`src/moments/events.ts` 的 `momentEventOf`）：用户动态 →「[user]的心情动态」、AI 自身动态 →「我的心情动态」、好友动态 →「朋友圈日常」；
- 帖子本身的记忆与它下面的互动片段挂同一事件，不单独建「和[user]在动态下的互动」事件；
- 好友单人动态同样写一条记忆（「朋友圈日常」），AI 之后能记得朋友刷过什么。

**配置**：模板 `moment_generation_prompt` / `moment_comment_prompt`（`schedule_generation_prompt` 已扩展输出 `post_plan` 段）；阈值见「八、配置持久化」。

---

## 好友圈（AI 自己的熟人，2026-10-18 上线）

`friend_personas` 是「这个人是谁」的唯一真相源；`user_info.social_graph` 是**用户**的人际关系，两个桶不混用、注入路径也不同。

**生成与登场**（`src/friends/roster.ts`）
- 时机：首轮对话完成后生成一次（`chat.tsx` 助手回复落库后调用）；`useMomentsEngine` 的 60s tick 只做兜底，且要求已有聊天记录。**永不自动重掷**。
- 错峰登场：`debut_at` 按天铺开（首位今天，其余 +1~4 天）。未登场的人不发帖评论、不进 feed。**会话列表的私聊入口要等 ta 在朋友圈露过面**（`hasFriendAppeared`：发过动态或评论，或已经私聊过）——光到登场时间就凭空多出一个陌生联系人太出戏。
- 偏好「首秀前保存」→ 全部未登场时静默重掷（无关系损失）；「首秀后保存」→ 设置页弹二选一（只影响以后 / 按偏好重建）。
- 管理：改名（只改称呼）、停用/启用、换一个（下线一位 + 补一位）、删除（`is_deleted=1`，历史动态保留名字）、重建（全体停用 + 新一批）。停用/删除**不洗记忆**。

**发帖**：好友不发周计划，改为每天按 `stableHash(friend_id + 日期)` 掷一次骰（`friend_moment_probability`），命中就插一条 `post_plan(author='friend')`，执行层沿用「时段内随机时刻 + 15% 临场放弃 + 错过即 skipped」（放弃概率是 `engine.ts` 的固定常量 `FRIEND_POST_SKIP_PROBABILITY`，不做成设置项）；掷出的时段已经过去时**顺延到当前时段**（否则刚登场的人第一天就被置 skipped，一条都不发）。内容由 `friend_moment_generation_prompt` + 小传生成，发帖后写一条「朋友圈日常」记忆片段（AI 之后接得上「小雨那条动态」）。

**评论**（`src/friends/service.ts`）：**每位已登场好友独立掷骰**（`friend_comment_probability`，默认 0.5）决定「谁刷到了这条动态」，刷到的人（含小传）一起进提示词，**由模型判断谁真的会开口，可以一个都不回**；人数不设上限，同一个人在同一条下不重复。好友动态之间互不评论（不做群聊）；用户评论好友动态时本人可能被动回评（`friend_comment_prompt` 单人版）。好友只拿得到「动态 + 已有评论」，**看不到主 AI 与用户的私聊**。

好友留言有两条生成路径，最后都走 `scheduleFriendComment()` 延迟落库（评论区是陆续冒出来的）：
- **AI 自己的帖子**：随发帖请求一次生成（`friend_comments`，`generateMoment` 只收候选名单里存在的名字），第一条 20s~2min、后面每条再推 1~3min；
- **用户发的帖子 / 已有互动**：候选池 → 一次 `friend_comments_prompt` 调用，模型返回 0~N 条，逐条错开 5s~几分钟落库；同一帖子两次候选池生成之间有 2 分钟冷却（`POOL_COOLDOWN_MS`），避免连发评论反复调模型。

**按名字命中**（`src/friends/persona.ts` → `assembler` 的 `friendMention`）：输入命中好友名时，记忆区最前面注入最近 4 条相关记忆，权重置顶；不注入小传、不单列人物标题。好友关系内嵌在名字后面（`3天前 小雨（发小，嘴毒心软）说…`），**每位好友每轮只补一次**，所有记忆行平级。这 4 条按片段 id 与本轮检索召回的结果去重，不重复注入同一条记忆。

**好友私聊**（`app/friend/[id].tsx` + `src/friends/chat.ts`）
- 会话列表「朋友」区在好友于朋友圈露过面后出现（`hasFriendAppeared`），点进二级私聊页；复用 `ChatBubble` / `InputBar`，滑动窗口（无 `friend_threads` 表，MVP 方案）。
- 上下文＝好友版 system prompt（固定格式包裹小传）+ 该线程历史 + 近期 feed + 该好友相关记忆；**无状态区/记忆区/灵光一闪/游戏区**。
- 消息带 `friend_id`：主聊天页与 `chatStore.getHistory()` 全部过滤，`runConsolidation` 跳过（不计 turn_counter）——**私聊内容不进主 AI 记忆**。
- 离开页面写一条弱痕迹（`insertEpisode("和{名}聊天")`：知道聊过、不知道内容，每好友 6 小时最多一条）。

---

## 每日实况（有自己的生活，2026-10-18 上线）

`behavior_schedule` 只剩「习惯」（周基线），`daily_log` 是「今天具体怎么过的」。`src/memory/dailyLife.ts`：

- **触发**：聊天页启动 / 动态引擎 60s tick → `ensureDailyLife()`；一天一次（in-flight 护栏 + 30 分钟失败退避 + 0-6 点不生成）。
- **输入**：本周基线 5 格、昨天实况、今天凌晨状态、节假日语义（`holidays.ts`）、按日期种子的伪天气、用户在场（今天的 `events`、当前处境 `condition`、昨晚聊天时间、昨天的心情动态）。
- **输出**：`slots`（1~5 条，**最多留白 2 格**；每条 20~45 字、以 `[ai]` 开头的完整一句）、`mood`、`highlight`（≤15 字）。全留空视为生成失败。
- **周表契约**：`schedule` 必须 7×5=35 格排满——某格缺失且当天实况也留白时，那一刻没有兜底，状态注记整条不注入。activity 同样以 `[ai]` 开头、提到用户写 `[user]`；LLM 失败时的默认表与 0-6 点的深夜文案也带 `[ai]`，保证这个不变式在代码里不会被打破。
- **回退**：失败不写库，`getCurrentScene()` 该格留白/整日缺失时回退周基线；功能不降级。
- **情境渲染**：两个出口共用同一句素材，只差人称——`formatScene` 把正文里**所有** `[ai]`（不管在开头还是句中）换成「你」给发动态与生成好友取景（这两处提示词是第二人称，不带上一格），`formatSceneNote` 保留主语、前面加时段、再补上一格给聊天旁白。**不复述 done 流水账**；`done` 只作素材。`[user]` `[ai]` 在出口渲染成当前称呼，改名后旧文案跟着变。
- **可核对**：设置页「AI 作息」只读展示今日实况（逐格对照习惯、标出当前时段）与本周习惯表；今天还没实况时明说按习惯兜底。
- **深夜因果**：0-6 点状态按日期种子取自 `daily_log.late_night`，清晨生成读同一个值 → 「凌晨四点才睡，闹钟响到第三遍」自然成立。
- **习惯化**：下一次周表生成的 `{{last_week}}` 优先用近 7 天 `daily_log` 实况（没有才回退上周计划）——重复出现的事自然沉淀成习惯，只试过一次的事自然消退。

**配置**：`daily_life_generation_prompt` + `friend_*_prompt`；阈值 `friend_roster_size` / `friend_moment_probability` / `friend_comment_probability`（均可在设置页调）。

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
system  : systemPrompt   系统人设（永久稳定）
system  : today          今天的日期/周几/假期语义（同一天内恒定，不带时刻）
system  : statePrompt    状态区：只放用户侧画像（两次巩固之间稳定）
...chatHistory           历史 + 当前输入（含状态注记；随对话增长，已结束对局折叠为一条 [游戏回顾]）
system  : gameSection    游戏区（对局中稳定；非对局无此段）
system  : memoryPrompt   记忆区（每次检索可能变化）
system  : gameHint       游戏回合指令（对局中，置末就近影响本轮回复）
system  : eventNudge     事件提醒（临近 / 过期关心）
```

顺序意图：越稳定越靠前。用户侧画像（人设 / 日期 / 状态区）进缓存前缀；AI 的情境随历史走、不占前缀；记忆区每轮变、游戏区随对局变，放在历史之后不影响上面的历史。

前台上下文的缓存约束（改前台历史渲染前先看这一条）：**历史里每条用户消息都带固定前缀，渲染结果永不随轮次变化**；情境旁白是例外，不带时刻，也不推进巩固流的分段计时。当天的消息写 `[HH:mm]`（日期已由前置的「今天是…」说明），更早的写 `[M/D HH:mm]`——跨天那一刻前缀正好跟着日期锚点一起变，不额外多付一次失效。曾经只给「最后两条用户消息」带时间，结果上一轮的最末一条下一轮变回无前缀，等于每轮改写历史中段，前缀缓存从那条起全废。巩固提取的历史不在这条约束内：它按 30 分钟断开分段、只在段首标一次（见「写入（巩固流）」），两套规则别互相套用。

### 模板变量

- 通用：`[user]`（用户名）、`[ai]`（AI 的名字）、`[now]`（当前时间，如"2026年10月7日（周三）15:30"）、`[today]`（今天是：日期+周几+假期/调休语义，如"今天是2026年10月7日（周三），国庆节假期"；周末/假期/调休才带语义后缀，普通工作日省略）；系统人设 / 冷启动 / 状态区 / 记忆区 / 事件提醒都认这四种，且不区分大小写、全角【user】也按占位符处理
- 记忆事件：`[time]`（相对时间，如"两个月前"）
- 状态区：`{{nickname}}`（未设昵称时为「用户」）/`{{occupation}}`/`{{location}}`/`{{social_graph}}`/`{{traits}}`/`{{conditions}}`/`{{events}}`（`{{traits}}` 来自画像属性桶、`{{conditions}}` 是仍在持续的处境（标签 + 「X天前开始的」）、`{{events}}` 来自 `memory_events` 的 upcoming/caring 带发生时刻），空字段整行自动隐藏（含空段落标题）。老覆盖模板里若还留着 `{{current_status}}`/`{{friends}}`，一律渲染成空行，**不要再使用**
- 未来事件提醒（隐形）：`event_reminder_template`（临近）/`event_care_template`（过期关心），`{{event}}`/`{{due_time}}`（后者渲染发生时刻），拼在消息末尾
- 记忆区：`{{event_list}}`、`{{epiphany}}`。日期锚点已前置为独立 system 消息（见上表），默认模板不再放 `[today]`；老覆盖模板里写了 `[today]` 仍会渲染，但会与前置那行重复，建议删掉
- 上下文模板（`{{{system_prompt}}}` 等三花括号变量）已随「分条发送」改造彻底移除，配置里不再有 `context_template`
- **往提示词里塞外部文本必须过 `applyIdentityPlaceholders`**（`src/prompt/assembler.ts` 导出，`background.ts` 里包成 `fillIdentity`）：用户自定义的人设、模型写的好友小传/摘要、动态作者署名都带 `[user]`/`[ai]`，不过这一层就会原样漏给模型。例外只有两类——`extraction_prompt` 里的 `[user]/[ai]/[time]` 是**要求模型输出的规范**，`friend_persona_generation_prompt` 里的 `[与[user]的关系]` 是要模型照抄的分段标签，这两处不能替换

设置页区块均可折叠：外观 / API / 模型路由 / 记忆检索 / 记忆流转阈值 / 提示词设置（含生活与动态）/ 用户画像 / 好友圈 / 未来事件 / 活跃记忆事件 / 数据管理 / 版本信息，并提供变量选择器、AI 提取人设、数据管理。「活跃记忆事件」详情看全事件与片段字段，可改事件标题 / 优先级 / 权重 / 别名、片段检索词 / 优先级；其余字段只读。

---

## 八、配置持久化（AsyncStorage）

| 内容 | 位置 |
| --- | --- |
| API Key、Base URL、AI 名称、流式开关、思考模式、自定义主题色 | `settingsStore.ts`（AsyncStorage） |
| 聊天历史（`chat_messages`） | `chatStore.ts`（persist） |
| 主题模式（`theme_mode`） | `theme/useTheme.ts`（persist） |
| 提示词覆盖层 | `prompt/config.ts` |
| 检索屏蔽词（`blocked_keywords`）、好友偏好（`friend_preferences`） | `settingsStore.ts`（独立 key，与提示词覆盖层同范式） |

**用户称呼不做双写**：唯一真相源是 `user_info.basic_identity.nickname`（SQLite）。`settingsStore.user_nickname` 只是内存镜像，`saveUserNickname()` 写库后同步镜像；AsyncStorage 不再保存称呼。

**阈值配置项**（`prompt/defaultConfig.json` → `thresholds`）：
- `consolidation_window_turns`（默认 10）：巩固的**最小窗口**轮数，少于这么多条不触发（避免碎片化）
- `consolidation_token_budget`（默认 10000）：未巩固对话累计到多少 token 触发巩固
- `consolidation_idle_minutes`（默认 30）：用户停多久后把不满预算的积压也消化掉
- `context_history_rounds`（默认 10）：冷启动（还没有摘要 / 用户画像）与好友私聊的历史窗口轮数；主聊天在有摘要后不带轮数截断
- `context_token_budget`（默认 18000）：上下文总预算（人设 + 日期 + 状态区 + 摘要 + 历史 + 记忆区）；必须 ≥ `consolidation_token_budget` + 各固定段的体积，否则会在巩固触发前就开始丢历史
- `detail_visible_weight`（默认 60）：详细/简略切换权重阈值，实时权重低于它的记忆只注入一句话 gist（命中事件同样降级）；调高=更多记忆变简略
- `moment_ai_comment_probability`（默认 0.6）：AI 主动评论用户动态的概率
- `moment_ai_reply_delay_ms`（默认 8000）：AI 评论/回评的随机延迟基准（±50% 抖动：回评约 3~15s，主动评论约 30s~3min）
- `moment_post_skip_probability`（默认 0.15）：AI 发帖计划的「临场放弃」概率（想发又没发）
- `friend_roster_size`（默认 5）：好友花名册人数（重建时生效）
- `friend_moment_probability`（默认 0.35）：每位好友每天发帖的概率（按 `好友id+日期` 确定性掷骰，当天不变）
- `friend_comment_probability`（默认 0.5）：**每位好友「刷到这条动态」的概率**；刷到的人设进提示词后由模型决定谁真的留言（可 0 人，人数不设上限）
- `recent_moment_recall_weight`（默认 0.2）：每 1× 动态新近度折算的灵光一闪概率，4×（AI 刚发/被用户刚评论）→ 约 0.82；调高=更容易提起刚发的帖子。好友自己发帖不计倍数

---

## 九、相关文档

| 文件 | 说明 |
| --- | --- |
| ~~`CLAUDE.md`~~ | 已封存（2026-09-28），其流程与排期记录整体迁移至 `ARCHIVE.md`，不再使用 |
| `PRD.md` | 产品需求文档 |
| `ARCHIVE.md` | 历史版本、已完成任务、踩坑经验归档；含已封存的 CLAUDE.md 流程留档 |
| `docs/` | 评估脚本生成的报告 |

---

## 十、当前进度

已完成 P1~P7（基建、数据层、记忆引擎、聊天流、巩固流、UI）与 P10/P11 系列功能；`src/version.ts` 的 `RELEASE_VERSION` 随每次 OTA 递增（设备端「版本信息」显示的就是它）。**游戏系统（4 款）已上线。**

**做梦流（P6）已下线**：原"前台闲置 180s → LLM 折叠冷事件"机制于 2026-09-29 移除，`src/memory/dreaming.ts` 及其调用、`dream_consolidation_prompt` 配置项、`getColdestEvents` / `softArchiveBatch` 查询函数一并删除。下线原因是它会物理删除被折叠事件下的全部记忆片段，并以高权重插入无片段的概括事件挤占 Top N，净收益为负。若将来重建，核心原则是让片段随事件迁移而非删除。

**近期迭代**：上线游戏系统（20问 / 数字炸弹 / 快艇骰子 / 真心话大冒险）+ 整局卡片化；已结束对局合并进上下文（一条 `[游戏回顾]`）；未来事件提醒改为隐形提示词注入（临近/过期由 AI 在回复里自然提起/关心，原「主动发可见消息」流程已下线）；AI 回合加人类反应延迟（`humanDelay`）；流式回复改为在目标对局框内输出（不再「框外打字 → 完成后跳进框」）；20问结束流程改为「框外庆祝提示 → 整局折叠 → 结束感想落在框外且不并入 `[游戏回顾]`」；`emotion` 列下线并并入 `summary`，记忆片段改为 `gist` / `summary` 分层存储与分层注入。并做了一轮隐患审查修复：上下文 system 角色报错、任务失败误删、渲染 key 重复、状态机卡死、退出竞态、定时器闭包过期等。

**记忆引擎一轮重构（2026-10-02）**：分词改 bigram + 重合度打分（旧版 6 字切片几乎命中不了）；修掉「记忆区 Top N 锁死在最早创建的事件」（`active_weight` 恒为 100，按它排序等于不排序）与「灵光一闪从来不触发」（筛选条件同样依赖该列）；衰减放慢（0.06/h → 0.02/h）；巩固支持一次产出多条片段并写入 `keywords` 关键词索引；新建事件前查语义重复；Token 超限改为「先降级到一句话再删块」；灵光一闪改为优先联想命中并带上 gist；画像数组加上限。**巩固游标从数组下标改为按消息 id 锚定**（删掉历史里的旧对局卡片会让中间一截对话永久丢失）。

**聊天页滚动定位（2026-10-02 修复）**：历史消息分页为「只渲染最后 `PAGE_SIZE=30` 条，滑到顶部再加载更早」。两个已知坑：
1. 定位到最新消息不能只做一次——`chatStore` 是 zustand persist，消息从 AsyncStorage **异步水合**，可能晚于首帧；气泡逐个渲染也会让 `contentSize` 继续长高。改为「只要还没定位成功、且用户没上翻历史（`atBottomRef`），每次消息数变化都重试」，并在 0/120/400ms 补滚。
2. 从列表页等处回到聊天页时屏幕可能重挂载、滚动位置回到顶部，用 `useFocusEffect` 重置「已定位」标记，重新定位一次。
3. `onStartReached` 只在「进入顶部区域」时触发一次，停在顶部不动不会再触发；顶部额外放了一个「加载更早的消息（还有 N 条）」显式入口兜底。

**P8 代码级验证完成（2026-10-05）**：用 Node + node:sqlite 内存库 + 三个 stub（expo-sqlite / AsyncStorage / openai）离线跑真实源码，P8-1/2/3 共 139 条断言全过（巩固流游标/去重/Merge 上限、灵光一闪弱关联与截断顺序、冷启动无 undefined 与消息顺序）。真机端到端（真实 LLM 提取质量、SSE、真机首条消息）待做；验证中发现两个轻微项待决策：记忆区事件数可为「上限+1」（默认事件 unshift 在 slice 之后）、设置页「恢复默认」按钮热区偏小。

提示词编辑器重构（P9-1）UI 已全部落地，剩真机验收与上述热区小修。

**心情动态 + 微信式导航（2026-10-08）**：新增心情动态（类朋友圈）——用户发帖（心情标签+正文）、AI 按随作息表生成的周发帖计划不定期发帖（三层真人感：计划可零帖日 / 时段内随机时刻+临场放弃 / 错过不补发）、评论互通（回评 3~15s、主动评论概率+30s~3min，失败静默放弃）、互动闭环双向写记忆（「[user]的心情动态」「和[user]在动态下的互动」「我的心情动态」）。导航改为微信式两层：底部三 Tab（私藏=会话列表 / 动态 / 设置），聊天页迁至 `app/chat.tsx` 二级页（左上返回，右上设置入口移除），聊天/游戏逻辑零改动；`checkAndGenerateSchedule` 加 in-flight 护栏防重复生成，`useMomentsEngine` 挂根布局全局调度。发帖计划表 `post_plan` 状态机：`pending → posted | skipped`。

**「想起」逐条分层（2026-10-09）**：命中事件不再整块擦亮——只有被当前话题**真正唤起**的片段（关键词实质重合，`cuedFragmentIds`）回到完整 `summary`，其余片段按**各自年龄**过遗忘曲线逐条决定 `summary`/`gist`；`capFragments` 必保唤起条（超额先丢未唤起且更旧的）。纯渲染层改动（retrieval 算唤起、assembler 逐条分层），数据与命中刷新机制不动。

**巩固时间正确性 + 聊天体验四项（2026-10-08）**：① 巩固落库与提取提示词的时间戳统一沿用**批末消息时间**，修复「几天前的对话被巩固成今天刚发生」；② 聊天列表微信式日期分隔条（间隔 ≥5 分钟或跨天显示：今天 HH:mm / 昨天 / 星期X / YYYY年M月D日），纯展示层；③ 记忆区命中片段同样按实时权重降级为一句话 gist（此前命中片段永远全文），详略阈值 40→60 并进设置可调（`detail_visible_weight`），冷记忆线拆出 `COLD_MEMORY_MAX_WEIGHT=40` 保持灵光一闪池语义不变；④ 重新生成加「收起+淡出」过渡动画（`LayoutAnimation` 220ms，动画结束后再发起重答），消除删末尾消息的布局跳变（编辑后重发的跳变按用户选择本次未处理）。

---

## 十一、部署与 Git 推送认证（HTTPS + PAT，不走 SSH）

> 本文件原名 `CODEBUDDY.md`。`ARCHIVE.md` 中的旧名引用属留档，不改。

### 远端与分支

- 远端：`https://github.com/QuietyAwe/jingjing.git`（**HTTPS**，非 SSH；不配 `core.sshCommand`，也不用 SSH key）。
- 默认分支 `master`；另有 `dev` 分支（承载文档及非主干改动，master 保持不动）。

### 凭据：两个 git credential helper 接力

写在 `/root/.gitconfig`：

| helper | 实现 | 作用 |
|---|---|---|
| `/usr/local/system/bin/git-credential-helper` | 系统级 Go 二进制 | 基础兜底 |
| `!/root/.git-gh-cred.sh` | 一段 shell 脚本 | **实际提供 token** |

`!` 前缀 helper：动作（`get`/`store`/`erase`）由 git 作为 `$1` 传入，凭据属性走 stdin；脚本从 `$1` 取动作。

### token 从哪来

`/root/.git-gh-cred.sh` 在 git 每次需要认证时读取：

```
/root/.codebuddy/.mcp.json
→ mcpServers.github.headers.Authorization  (Bearer <TOKEN>)
```

把 Bearer token 抽出来，按 git credential 协议回给 git：

```
username=x-access-token
password=<PAT>
```

即 **GitHub 登录授权复用 MCP `github` 连接器的授权**，无需每次 push 重新登录。push 时 `x-access-token` 作用户名、PAT 作密码走 HTTPS 校验。

### 提交与推送

提交用固定身份（覆盖全局，因为全局没设 user）：

```bash
git -c user.name='QuietyAwe' -c user.email='3283659610@qq.com' commit -m "..."
git push origin dev          # 或 origin master
```

新建并推送远端分支：

```bash
git checkout -b dev
git push -u origin dev
```

### 已知坑：443 偶发超时

`github.com:443` 在沙箱里**偶尔连接超时**。发生时不要反复重试同一条命令，换一次 `git fetch` / `git push` 重试，通常第二次就通。
