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

- **增量补式记忆巩固**：每 10 轮对话触发一次后台 LLM 提取，把近期对话沉淀为「记忆事件 + 记忆片段」，并增量 Merge 进用户画像。
- **冷记忆随机扰动（灵光一闪）**：检索时随机抽取低活跃度的冷记忆注入上下文，制造"突然想起"的效果。
- **艾宾浩斯衰减**：记忆活跃权重随时间衰减，权重影响检索排序。
- **15 轮滑动窗口**：聊天上下文窗口。
- **冷启动兼容**：空库时套用冷启动模板与默认占位符，首次对话也能自然开场。

### MVP 边界

- **范围内**：本地 SQLite、纯 JS 分词检索（先事件后片段）、衰减、滑动窗口、巩固流、冷启动降级、参数配置解耦、前后台模型路由。
- **范围外**：云端同步、多账号、服务端存储、多模态（语音/图片）记忆、原生 FTS5 分词。

---

## 二、快速开始

```bash
npm install
npm start          # 启动 Expo Dev Server
npm run android    # 运行 Android
npm run ios        # 运行 iOS
npm run web        # 运行 Web
```

首次启动需在**设置页**填写 `API Key` 与 `Base URL`（默认 DeepSeek），配置保存在 AsyncStorage。不配置 Key 时，巩固流会自动跳过，聊天仍可用。

云构建（Android APK）：

```bash
eas build --platform android      # 配置见 eas.json
```

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
  _layout.tsx           # 根布局
  (tabs)/index.tsx      # 聊天页
  (tabs)/settings.tsx   # 设置页
src/
  components/           # 通用 UI：ChatBubble、InputBar、CollapsibleSection
  db/                   # SQLite 连接、建表（schema.ts）、CRUD（queries.ts）
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
    promiseChecker.ts   # 承诺/待办检查
  prompt/
    defaultConfig.json  # 默认提示词配置
    config.ts           # 配置读写（AsyncStorage 覆盖层）
    assembler.ts        # Prompt 拼装与模板渲染
  store/
    chatStore.ts        # 聊天消息 + 调试日志（persist）
    settingsStore.ts    # API Key / 开关 / 主题色
    metaStore.ts        # 系统元数据（轮次、锁、情绪等运行时状态）
  theme/                # 浅色/深色色板（colors.ts）+ useTheme.ts
  types/schema.ts       # 全局类型定义
docs/                   # 设计稿（如 prompt-editor-redesign.md）
```

---

## 五、数据模型（SQLite）

| 表 | 字段 |
| --- | --- |
| `memory_events` | `id` PK、`event_text`、`timestamp`、`active_weight`(1-100)、`last_accessed`、`priority`(1-9)；索引 `idx_events_weight (active_weight DESC)` |
| `memory_fragments` | `id` PK、`index`（父事件 ID，**列名为 `index` 而非 `event_index`**）、`timestamp`(ISO8601)、`summary`(≤50 字)、`emotion`、`priority`(1-9)；索引 `idx_fragments_index ("index")` |
| `system_metadata` | `key` PK、`value`；常用 key：`is_locked`、`turn_counter`、`last_consolidated_index`、`default_event_id` |
| `user_info` | `basic_identity`、`preferences`、`social_graph`、`psycho_state`、`life_quests`（巩固流增量 Merge）；**用户称呼的唯一真相源**为 `basic_identity.nickname` |
| `behavior_schedule` | `id` PK、`week_start`、`day_of_week`(0-6)、`time_slot`(0-4)、`activity`、`created_at`；索引 `idx_schedule_week`。**存的是 AI 自己的作息**，用于状态区注入 AI 当前在做什么 |

时段编码：`0=早(6-9) 1=上午(9-12) 2=午(12-15) 3=下午(15-18) 4=晚(18-23)`，0-6 点为深夜特殊处理（随机「已睡/被叫醒/失眠」等状态）。

> 历史上 `memory_events` 曾有 `"index"` 与 `is_archived` 两列：`index` 全仓无读取点，`is_archived` 随做梦流下线失去写入方（恒为 0）。两者已在 `initSchema()` 的迁移中删除（`DROP COLUMN`，旧设备上失败也不影响，全部 SELECT 使用显式列名）。

## Prompt 预算与截断

- 预算 8000 token（估算：中日韩字符 ≈ 1 token/字，其余 ≈ 4 字符/token）
- 预算覆盖「系统人设 + 状态区 + 记忆区 + 历史」四段
- 超限顺序：先删灵光一闪 → 按实时权重从低到高删记忆块（事件行连同其片段行整块移除）→ 仍超则丢弃最旧历史（至少保留最后一轮）

**默认事件「日常闲聊」**：巩固流兜底事件，LLM 可把片段挂靠其上，但排除在检索 / TopN / 灵光一闪之外。

---

## 六、运行状态机

```
主干：IDLE → RETRIEVING → CHAT_PENDING → CONSOLIDATING → IDLE
```

异常与降级：

- 持久化死锁：App 启动时强制 `is_locked = false`。
- 巩固超时 30s：强制解锁、丢弃快照、不累加轮次计数。
- 空库冷启动：应用 `cold_start_template` + `default_placeholders`。

---

## 七、Prompt 体系

### 消息发送顺序（前缀缓存优化，勿随意调整）

```
system  : systemPrompt   系统人设（稳定，缓存 100% 命中）
system  : statePrompt    状态区（巩固窗口内稳定）
...chatHistory           历史（前缀相对稳定）
system  : memoryPrompt   记忆区（每次检索可能变化）
user    : latestMessage  当前输入
```

### 模板变量

- 通用：`[user]`（用户名）、`[now]`（当前时间）
- 记忆事件：`[time]`（相对时间，如"前两个月"）
- 状态区：`{{nickname}}`、`{{likes}}`、`{{current_status}}` 等 15 个，空字段整行自动隐藏（含空段落标题）；`{{current_status}}` 注入的是 **AI 自己的作息状态**（如「（私藏的作息）当前：在窗边看书」），不是用户行为
- 记忆区：`{{event_list}}`、`{{epiphany}}`；底部显示当前日期时间（中文周几）
- 上下文模板：`{{{system_prompt}}}`、`{{{state_info}}}`；`{{{memory_events}}}` 已弃用（改为分条发送）

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
- `context_active_events_limit`（默认 10）：记忆区加载的高权重事件数

---

## 九、相关文档

| 文件 | 说明 |
| --- | --- |
| ~~`CLAUDE.md`~~ | 已封存（2026-09-28），其流程与排期记录整体迁移至 `ARCHIVE.md`，不再使用 |
| `PRD.md` | 产品需求文档 |
| `ARCHIVE.md` | 历史版本、已完成任务、踩坑经验归档；含已封存的 CLAUDE.md 流程留档 |
| `docs/` | 设计稿（提示词编辑器重构等） |

---

## 十、当前进度

已完成 P1~P7（基建、数据层、记忆引擎、聊天流、巩固流、UI）与 P10/P11 系列功能；最新版本 v1.7。

**做梦流（P6）已下线**：原"前台闲置 180s → LLM 折叠冷事件"机制于 2026-09-29 移除，`src/memory/dreaming.ts` 及其调用、`dream_consolidation_prompt` 配置项、`getColdestEvents` / `softArchiveBatch` 查询函数一并删除。下线原因是它会物理删除被折叠事件下的全部记忆片段，并以高权重插入无片段的概括事件挤占 Top N，净收益为负。若将来重建，核心原则是让片段随事件迁移而非删除。

进行中：提示词编辑器重构（P9-1）。
待启动：巩固流端到端验证（P8-1）、灵光一闪 + Token 截断验证（P8-2）、空库冷启动验证（P8-3）。
