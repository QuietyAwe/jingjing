# PRD: 情感陪伴App「私藏」本地记忆引擎工业级规范 (v1.1-AI-Ready)

## 1. 一句话定义与 MVP 范围

一款基于 Expo (React Native) + 本地 SQLite 实现的、具备增量补丁式短期记忆巩固、近期动态优先的「灵光一闪」、轻量纯 JS 分词匹配与全方位冷启动兼容机制的端侧隐私型情感陪伴记忆引擎。

### IN 范围（开发涉及）

* **上下文拼装架构**：会话摘要 + 游标之后未巩固的对话（无摘要时回退最近 N 轮） + 状态区（画像两桶 + 未来事件 + AI 当前处境） + 记忆区（检索命中事件 + 1 条氛围记忆，未命中不注入），支持动态 Token 截断。


* **增量巩固机制**：未巩固对话攒到 token 预算或空闲超阈值时（至少 10 轮）异步发送「固定指令 + 新对话 + 关键词倒排候选事件」至后台模型，返回画像增量、记忆片段、事件归并指令与会话摘要，按 token 预算分批消化，带超时解锁。


* **轻量本地检索**：纯 JS 中文分词过滤停用词，利用 SQLite `LIKE` 模糊查询非归档数据，限制检索词上限。
* **参数配置解耦**：提示词、流转阈值、艾宾浩斯衰减系数、模型路由参数、冷启动模板与默认占位符完全解耦。



### OUT 范围（开发不涉及）

* 云端同步、多账号体系、服务端存储及多模态（语音、图片）记忆。


* 基于原生 C/C++ 编译的 SQLite FTS5 深度分词。

---

## 2. 核心业务流 (Core Flow)

### 2.1 用户交互与检索流（含冷启动及灵光一闪）

1. **冷启动与默认占位检测**：
* 在拼装 Prompt 前，系统优先读取 `user_info` 表。


* 若 `user_info` 各项字段为空（初次打开 App），则拼装层不渲染空标签，直接使用解耦配置中的 `cold_start_template` 注入上下文，引导 AI 主动提问；若部分字段缺失，则采用配置中的 `default_placeholders` 进行安全兜底渲染，防止 JS `undefined` 崩溃。


2. **输入与切词**：用户发送消息后，纯 JS 分词对每段连续汉字做 **2 字滑窗（bigram）**，上限 16 个关键词、超长输入均匀抽样；身份名（用户昵称 / AI 名）作为屏蔽词剔除。中文没有空格，硬切词反而会漏召回——bigram 保证「妈妈」这类词必以某个 gram 出现。
3. **本地检索（先事件、后片段）**：
* 事件层粗召回（标题或别名命中，排除默认事件「日常闲聊」与未到期的未来事件），SQL 只做 OR 粗筛，排序在 JS 里按「命中了几个不同关键词」（重合度）精排，避免命中即算数：
```sql
SELECT e.* FROM memory_events e
WHERE e.id != :default_event_id
  AND e.event_status != 'upcoming'
  AND (e.event_text LIKE '%词1%'
       OR EXISTS(SELECT 1 FROM memory_event_aliases a
                 WHERE a.event_id = e.id AND a.alias LIKE '%词1%'))
ORDER BY e.last_accessed DESC
LIMIT 15;
```
* 事件未命中时再检索片段（`gist` / `summary` / `keywords` 三者都参与），命中片段的父事件即视为命中事件。
* 命中后把事件的 `active_weight` 刷为 100、更新 `last_accessed`——权重刷新是**事件级**，渲染才是**片段级**分层。




4. **惰性衰减与记忆区拼装**：
* 对未命中的事件，读取时根据时间差（**单位：小时**）按艾宾浩斯公式实时计算当前实际权重。


* 从数据库中提取非归档、且当前计算权重最高的 Top 10 事件。




5. **“灵光一闪”扰动事件抽取**：
* 每次检索最多注 1 条，两条通道：
  1. **近期动态优先**：按 6 小时内各动态事件的新近度（AI 刚发帖 / 用户刚评论 4×，用户刚发 / 刚浏览 2.5×，好友刚发 1.5×）累加出概率 `0.05 + Σ(boost × recent_moment_recall_weight)`（默认权重 0.2 → 4× 约 0.85，上限 0.9），命中即取该事件 6 小时内最新片段；
  2. **冷记忆**：没有近期动态、或动态通道没掷中时，按 `epiphany_trigger_probability`（默认 0.05）从实时权重低于 40 的冷记忆里抽一条，优先与当前输入弱关联的。
* 每条动态只走一次高概率通道：提过即记入 `system_metadata.moment_recall_seen` 并移出候选，避免「只要有近期动态就每轮灵光一闪」。




6. **Prompt 拼装与截断**：
* 按照：`系统人设 + 状态区 + 会话摘要 + 未巩固历史 + 记忆区(检索命中事件 + 1 条氛围记忆 + 灵光一闪) + 游戏区` 顺序拼接；记忆区与游戏区后置，避免记忆变化打断历史段的前缀缓存。


* 检查总字符长度，若超出配置的 Token 预算限制，则从低到高依次剔除记忆区事件，优先保护当前预算内的未巩固对话与状态区的完整性。


7. **响应输出**：调用前台聊天模型生成回复。

### 2.2 异步巩固流（含双重关联写入）

1. **计数检测**：前台回复成功，系统将本地轻量存储中的 `turn_counter` 累加 1。当计数满 10 且 `is_locked == false` 时触发。


2. **加锁与快照投递**：将本地锁 `is_locked` 置为 `true`。开启 30 秒超时定时器。截取当前 `user_info` 全量 JSON 与游标之后、约一个 token 预算的对话快照。


3. **后台模型推理**：调用后台低成本模型。要求模型严格按照 4.4 节规定的格式输出：包含合并更新后的 `updated_user_info` 以及待生成的 `new_fragment` 实体。
4. **事务双重关联写入（生命周期闭环）**：
* 启动本地 SQLite 事务：
* **第一步：更新用户信息。** 将返回的 `updated_user_info` 与本地最新数据进行增量字典 Merge（对 `likes`, `dislikes`, `social_graph`, `life_quests` 等数组执行**值去重追加**，而非直接覆盖），写入数据库。
* **第二步：处理记忆事件。** 解析 `new_fragment`。
* 若 `target_event_text` 字段非空（代表本片段属于一个全新事件主题），则向 `memory_events` 插入新行，设置 `active_weight = 100`，获取其生成的自增主键 `new_event_id`；


* 若 `target_event_text` 为空，则根据语义匹配或直接默认挂靠至最近活跃的事件 ID。


* **第三步：写入记忆片段。** 将生成的 `new_event_id`（或匹配到的已有 ID）作为 `index` 字段，把 `gist` / `summary` / `keywords` / `priority` 与当前时间戳写入 `memory_fragments` 表。




* 提交事务。


5. **释放锁**：清除超时定时器，将本地 `turn_counter` 清零，`is_locked` 置为 `false`。



---

## 3. 状态机与异常降级 (States & Edge Cases)

### 3.1 核心状态机

| 当前状态 | 触发条件 | 目标状态 | 动作与数据变更 |
| --- | --- | --- | --- |
| **IDLE** | 用户发送消息 | **RETRIEVING** | 启动纯 JS 分词，执行 SQLite `LIKE` 查询。

 |
| **RETRIEVING** | 检索与衰减计算完成 | **CHAT_PENDING** | 执行 Token 预算截断，若为空库则应用 `cold_start_template`，拼装后请求前台模型。 |
| **CHAT_PENDING** | 回复完成，计数满 10 且未加锁 | **CONSOLIDATING** | 持久化计数，`is_locked = true`，启动 30s 超时定时器，异步请求后台模型。

 |
| **CONSOLIDATING** | 后台模型返回 / 30s超时触发 | **IDLE** | 执行增量数据 Merge 与双重关联写入，重置计数，`is_locked = false`。

 |

### 3.2 异常边界与兜底策略

* **持久化死锁与冷启动重置**：在 App 根组件挂载（如 React Native `useEffect`）时，强制执行 `is_locked = false` 的清理操作，确保在任何异常闪退或非正常退出后，下次启动能正常解除锁定。


* **巩固中途超时降级**：若异步巩固请求超过 30 秒（超时定时器触发），直接强制修改 `is_locked = false` 并丢弃本次快照，游标不推进，等待下一次触发，防止污染本地数据。


* **巩固事务原子性**：一次巩固的写库（事件归并 → 事件/片段 → 画像 Merge → 会话摘要）包裹在 SQLite `TRANSACTION` 中，异常时整体 `ROLLBACK`，不会留下半批数据；游标只在提交成功后推进。

---

## 4. 数据模型契约 (Data Schema)

### 4.1 SQLite 表结构定义

```sql
-- 表一：记忆片段表（一句话 gist + 详细 summary 分层）
CREATE TABLE IF NOT EXISTS memory_fragments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "index" INTEGER NOT NULL,            -- 父级记忆事件 ID（列名就是 index）
    timestamp TEXT NOT NULL,             -- ISO8601，沿用事情发生的时间
    gist TEXT NOT NULL DEFAULT '',       -- ≤20 字一句话印象，记忆变淡后只剩它
    summary TEXT NOT NULL,               -- 80~120 字：发生了什么 + 关键细节 + 情绪
    keywords TEXT NOT NULL DEFAULT '',   -- 逗号分隔的检索关键词（含同义说法）
    priority INTEGER NOT NULL DEFAULT 5  -- 1~9，重大片段衰减更慢
);
CREATE INDEX IF NOT EXISTS idx_fragments_index ON memory_fragments("index");

-- 表二：记忆事件表
CREATE TABLE IF NOT EXISTS memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
    last_accessed TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,         -- 1~9
    memory_kind TEXT NOT NULL DEFAULT 'daily',   -- daily / episode
    event_status TEXT NOT NULL DEFAULT 'none'    -- none / upcoming / caring / archived
);
CREATE INDEX IF NOT EXISTS idx_events_weight ON memory_events(active_weight DESC);

-- 表三：事件别名表（合并过的旧标题，检索时按「标题或别名」召回）
CREATE TABLE IF NOT EXISTS memory_event_aliases (
    event_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    PRIMARY KEY (event_id, alias)
);

-- 表四：系统元数据表（巩固游标 / 锁 / 会话摘要 / 浏览与提过记录）
CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

```

### 4.2 记忆衰减数学公式

活跃权重采用**小时级**惰性求值，读取时计算。设 $W_{last}$ 为最后一次调用时的权重，$t_{\Delta}$ 为当前时间与 `last_accessed` 的**小时数差值**（浮点数），$d$ 为艾宾浩斯衰减系数（默认值 `0.02`）：

$$W_{now} = \max\left(1, \left\lfloor W_{last} \cdot e^{-d \cdot t_{\Delta}} \right\rfloor\right)$$

### 4.3 app_config (可快捷自定义配置项)

```json
{
  "prompts": {
    "system_prompt": "你是一个温柔的情感陪伴助手...",
    "extraction_prompt": "提取后台记忆与用户信息...",
    "state_injection_template": "基础信息：{{nickname}}，所在地{{location}}...",
    "cold_start_template": "## [系统指引]\n你与[user]刚刚相识。你的数据库中目前没有任何关于[user]的信息。请用充满好奇、温柔、体贴的态度，在接下来的对话中，引导[user]慢慢向你介绍自己。"
  },
  "default_placeholders": {
    "nickname": "你",
    "location": "未知地方",
    "occupation": "神秘职业",
    "comm_preference": "喜欢温柔诚恳的沟通风格"
  },
  "thresholds": {
    "consolidation_window_turns": 10,
    "context_active_events_limit": 10,
    "recent_moment_recall_weight": 0.2
  },
  "weight_decay": {
    "ebbinghaus_decay_rate": 0.02,
    "epiphany_trigger_probability": 0.05
  },
  "model_routing": {
    "background_extraction_config": {
      "model": "gpt-4o-mini",
      "temperature": 0.0,
      "response_format": { "type": "json_object" }
    },
    "foreground_chat_config": {
      "model": "gpt-4o",
      "temperature": 0.7
    }
  }
}

```

### 4.4 后台模型提取契约 (JSON Response Model)

```json
{
  "updated_user_info": {
    "basic_identity": {
      "nickname": "阿宅",
      "gender": "男",
      "birthday": "2003年5月2日",
      "occupation": "自由插画师",
      "location": "上海"
    },
    "preferences": {
      "likes": ["手冲咖啡", "任天堂游戏", "雨天"],
      "dislikes": ["社交应酬", "太甜的甜点"]
    },
    "social_graph": [
      {
        "name": "老李",
        "role": "甲方客户",
        "attitude": "经常要求改稿，用户非常不耐烦"
      }
    ],
    "psycho_state": {
      "personality_traits": ["内耗"],
      "current_stressors": ["房租没凑齐"],
      "comm_preference": "喜欢用吐槽化解尴尬"
    },
    "life_quests": {
      "long_term_goals": ["去冰岛看极光"],
      "ongoing_tasks": [
        {
          "task_name": "完成老李海报",
          "status": "进行中"
        }
      ]
    }
  },
  "new_fragment": {
    "summary": "[user]今天因为房租还没凑齐感到焦虑，向你倾诉了工作的辛苦。",
    "emotion": "[user]现在感到疲惫和略带焦虑，期望听到温暖而幽默的安慰方式。",
    "target_event_text": "[user] [time] 在为这个月的房租发愁，并与你倾诉了工作上遇到的瓶颈"
  }
}

```

---

## 5. 极简验收标准 (MVP AC)

### AC 1: 增量补丁提取、双重关联写入与防擦除验证

* **Given**: 数据库内 `user_info` 的 `social_graph` 已有实体 `"name": "布丁"`。当前对话计数为 9，`is_locked` 为 `false`。


* **When**: 未巩固对话达到 token 预算或空闲阈值（完全未提及布丁）。生成前台回复后触发异步提取，模型返回 4.4 节格式的数据，其中包含新提取的片段且 `target_event_index` 字段有内容。


* **Then**:
1. 本地立即将锁状态置为 `is_locked = true`。


2. 事务执行成功：`memory_events` 中成功插入新行并生成自增 `id = 18`；`memory_fragments` 中成功写入一条 `index = 18` 的记录。


3. `user_info` 进行 Merge 后，“布丁”信息完好无损地保留，且新合并的信息成功更新。


4. 本地计数器重置为 0，`is_locked` 释放为 `false`。





### AC 2: “灵光一闪”扰动事件的抽取、去重与截断

* **Given**: 用户 10 分钟前评论过 AI 的一条动态（对应事件「我的心情动态」新增一条互动片段，且该片段未被提起过），聊天输入与该动态无关。
* **When**: 用户发送消息，系统拼装上下文。
* **Then**:
1. 近期动态通道概率 = 0.05 + 4 × 0.2 = 0.85，命中时注入该事件「6 小时内最新片段」的一行印象，并把片段 id 记入 `moment_recall_seen`；
2. 该片段此后不再参与高概率候选（每条动态只提高概率一次），同一条帖子不会被反复提起；
3. 没有近期动态（或动态通道未掷中）时走冷记忆通道：按 `epiphany_trigger_probability` 从实时权重 < 40 的事件里抽一条，优先与当前输入弱关联的；
4. 若拼装时 Token 超标，灵光一闪与低权重记忆块会被优先剔除，未巩固对话不受影响。



### AC 3: 空库冷启动与默认占位符降级验证

* **Given**: 数据库处于刚创建的空库状态，`user_info` 无任何实质数据。
* **When**: 用户发送第一条消息：“你好”。
* **Then**:
1. 系统不抛出 `undefined` 异常，渲染 Prompt 状态区时检测到数据为空，触发降级。


2. 自动应用解耦配置中的 `cold_start_template`。对于未定义的字段，拼装层使用 `default_placeholders`（如“未知地方”）进行防崩替换。
3. 前台模型接收到引导性的 System Prompt，并以一种引导性、探索性的人设态度进行安全的首轮回复。

---

## 6. 心情动态模块（v1.2 新增，2026-10-08）

### 6.1 功能定义

用户与 AI 双方均可发布心情动态（类似朋友圈），在彼此动态下评论互动；动态双向沉淀为记忆事件，AI 随时间保持「记得你的心情、有自己的生活」的陪伴感。

### 6.2 产品规则

**发帖**

* 用户手写发帖：正文（纯文字、可含 emoji）+ 心情标签单选（开心 / 平静 / 低落 / 烦躁 / 期待）。v1 不含图片（多模态在 MVP 范围外）。
* AI 发帖按「真人感三层」节奏，杜绝机械感：
  1. **计划层**：发帖计划随每周作息表在同一次 LLM 请求中生成（输出 `{schedule, post_plan}`），每天 0~2 条、允许整天不发，主题（`theme_hint`）只给方向不给正文；作息表与计划分开判定，本周有表但没有 AI 计划时补一份，只排还没过去的日子与时段；
  2. **执行层**：`useMomentsEngine` 挂根布局 60s 轮询，命中当前时段的待办后在时段内随机时刻触发，并有小概率「临场放弃」（`moment_post_skip_probability`）；
  3. **放弃层**：错过时段不补发（计划置 `skipped`）；LLM 生成失败保留 `pending` 下轮重试，时段结束仍未成功即 `skipped`。

**评论互通（无点赞，点赞列入后续迭代）**

* 用户评论 AI 动态 → AI 约 3~15s 随机延迟回评。
* AI 以概率 `moment_ai_comment_probability`（默认 0.6）主动评论用户动态，延迟约 30s~3min。
* 文案口语化、真人感（短句、可调侃、少 emoji）；生成失败静默放弃，不重试不打扰。

**记忆联动（双向进记忆，不等巩固流）**

* 事件按**帖子作者**归一个：用户动态 →「[user]的心情动态」、AI 自身动态 →「我的心情动态」、好友动态 →「朋友圈日常」；帖子本身的记忆与它下面的互动片段挂同一事件，不再单独建「和[user]在动态下的互动」（旧库启动时改挂合并）。
* 用户发帖即写记忆（即使本次没有互动，AI 之后也记得用户的心情）；好友单人动态同样写一条「朋友圈日常」片段。
* 灵光一闪**近期动态优先**：概率 = `0.05 + Σ(动态新近度 × recent_moment_recall_weight)`（AI 刚发/用户刚评论 4× → 0.85），没命中才按 5% 抽冷记忆；每条动态只提高概率一次。
* 遵守记忆片段规范（gist ≤20 字 / summary 80~120 字含 [time] 与情绪 / keywords 含同义说法），`insertEpisode` 同名事件只建一次、之后挂片段。

**导航（微信式两层）**

* 底部三 Tab：「私藏（会话列表）/ 动态 / 设置」。
* 一级会话列表：AI 会话条（头像、名字、最后消息预览、时间戳），结构预留多联系人扩展位；点入二级聊天页（`router.push("/chat")`）。
* 二级聊天页：左上「返回」回一级页；原右上「设置」入口移除（设置走底部 Tab）；聊天/游戏/滚动定位逻辑保持不变。

### 6.3 数据表（v1.2 新增）

```sql
CREATE TABLE IF NOT EXISTS moments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author TEXT NOT NULL CHECK(author IN ('user','ai')),
    content TEXT NOT NULL,
    mood TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS moment_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    moment_id INTEGER NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('user','ai')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,   -- 0=周一 … 6=周日
    time_slot INTEGER NOT NULL,     -- 0=早(6-9) … 4=晚(18-23)
    theme_hint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted','skipped')),
    created_at TEXT NOT NULL
);
```

### 6.4 配置项（defaultConfig.json）

* prompts 新增：`moment_generation_prompt`（发帖文案）、`moment_comment_prompt`（评论/回评文案）；`schedule_generation_prompt` 扩展输出 `post_plan` 段。
* thresholds 新增：`moment_ai_comment_probability`（0.6）、`moment_ai_reply_delay_ms`（8000，随机延迟基准）、`moment_post_skip_probability`（0.15）。

### 6.5 验收标准 (AC)

* **AC 1 发帖节奏**：本周作息表生成后 `post_plan` 同步落库；同一天可为 0 条；到时段后随机时刻发出（非整点）；手动把设备时间拨过时段后，pending 计划变 `skipped` 而不补发。
* **AC 2 评论互通**：用户评论 AI 动态后数秒~十几秒出现 AI 回评（带「正在输入」动效）；用户动态收到 AI 评论为概率事件；关掉 API Key 时不产生任何 AI 评论。
* **AC 3 记忆联动**：用户发帖后 `memory_events` 出现「[user]的心情动态」事件及片段（gist/summary/keywords 齐全）；AI 发帖后出现「我的心情动态」；好友发帖后出现「朋友圈日常」；互动闭环后片段追加到对应帖子作者的事件下并包含评论内容。
* **AC 4 导航**：会话列表点 AI 会话条进入聊天页，左上返回回列表；底部三 Tab 可达会话列表/动态/设置；聊天页无右上设置入口。