# PRD: 情感陪伴App「私藏」本地记忆引擎工业级规范 (v1.1-AI-Ready)

## 1. 一句话定义与 MVP 范围

一款基于 Expo (React Native) + 本地 SQLite 实现的、具备增量补丁式短期记忆巩固、冷记忆随机扰动（灵光一闪）、轻量纯 JS 分词匹配、前台闲置智能“做梦”与全方位冷启动兼容机制的端侧隐私型情感陪伴记忆引擎。

### IN 范围（开发涉及）

* **上下文拼装架构**：15 轮持久化滑动窗口 + 状态区（固定提示词 + 动态用户信息 + 情绪） + 记忆区（Top 10 活跃事件 + 1 条低活跃随机扰动事件），支持动态 Token 截断。


* **增量巩固机制**：每 10 轮对话持久化计数，异步发送“当前用户信息 + 10轮快照”至后台模型，返回最新全局用户信息、片段摘要及事件挂靠指令，带 30 秒超时解锁与初始化重置锁。


* **轻量本地检索**：纯 JS 中文分词过滤停用词，利用 SQLite `LIKE` 模糊查询非归档数据，限制检索词上限。
* **前台闲置做梦**：当 App 处于前台、用户闲置满 180 秒且非归档事件超过阈值时，触发冷数据 LLM 折叠合并，并将旧事件标记为 `is_archived = 1`。
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


2. **输入与切词**：用户发送消息，系统调用纯 JS 分词函数，剥离停用词，提取至多 3 个核心关键词。
3. **本地检索（Top 3 匹配）**：
* 执行 SQL 查询：
```sql
SELECT * FROM memory_events 
WHERE is_archived = 0 
  AND (event_text LIKE '%词1%' OR event_text LIKE '%词2%' OR event_text LIKE '%词3%')
ORDER BY active_weight DESC 
LIMIT 3;

```


* 若命中，将命中的事件的 `active_weight` 强制刷新为 100，更新 `last_accessed` 为当前 ISO8601 时间。




4. **惰性衰减与记忆区拼装**：
* 对未命中的事件，读取时根据时间差（**单位：小时**）按艾宾浩斯公式实时计算当前实际权重。


* 从数据库中提取非归档、且当前计算权重最高的 Top 10 事件。




5. **“灵光一闪”随机扰动事件抽取**：
* 为赋予 AI 偶然想起过去的惊喜感，系统执行以下 SQL 随机抽取 1 条非归档、长期未访问的冷记忆：
```sql
SELECT * FROM memory_events 
WHERE is_archived = 0 AND active_weight < 40 
ORDER BY RANDOM() 
LIMIT 1;

```




6. **Prompt 拼装与截断**：
* 按照：`系统人设 + 状态区(用户信息/情绪) + 记忆区(Top 10高权重事件 + 1条随机扰动事件) + 15轮历史对话` 顺序拼接。


* 检查总字符长度，若超出配置的 Token 预算限制，则从低到高依次剔除记忆区事件，优先保护最近 15 轮对话与状态区的完整性。


7. **响应输出**：调用前台聊天模型生成回复。

### 2.2 异步巩固流（含双重关联写入）

1. **计数检测**：前台回复成功，系统将本地轻量存储中的 `turn_counter` 累加 1。当计数满 10 且 `is_locked == false` 时触发。


2. **加锁与快照投递**：将本地锁 `is_locked` 置为 `true`。开启 30 秒超时定时器。截取当前 `user_info` 全量 JSON 与当前 10 轮对话快照。


3. **后台模型推理**：调用后台低成本模型。要求模型严格按照 4.4 节规定的格式输出：包含合并更新后的 `updated_user_info` 以及待生成的 `new_fragment` 实体。
4. **事务双重关联写入（生命周期闭环）**：
* 启动本地 SQLite 事务：
* **第一步：更新用户信息。** 将返回的 `updated_user_info` 与本地最新数据进行增量字典 Merge（对 `likes`, `dislikes`, `social_graph`, `life_quests` 等数组执行**值去重追加**，而非直接覆盖），写入数据库。
* **第二步：处理记忆事件。** 解析 `new_fragment`。
* 若 `target_event_text` 字段非空（代表本片段属于一个全新事件主题），则向 `memory_events` 插入新行，设置 `active_weight = 100`，获取其生成的自增主键 `new_event_id`；


* 若 `target_event_text` 为空，则根据语义匹配或直接默认挂靠至最近活跃的事件 ID。


* **第三步：写入记忆片段。** 将生成的 `new_event_id`（或匹配到的已有 ID）作为 `index` 字段，把 `summary`、`emotion` 与当前时间戳写入 `memory_fragments` 表。




* 提交事务。


5. **释放锁**：清除超时定时器，将本地 `turn_counter` 清零，`is_locked` 置为 `false`。



### 2.3 闲置做梦流

1. **条件触发**：系统检测到 App 处于前台（`AppState == 'active'`），用户无操作满 180 秒，且本地非归档事件数量（`is_archived = 0`）超过 50 条。
2. **数据打包**：拉取 `active_weight` 最低的 10 条冷数据事件。
3. **模型折叠**：调用 LLM 进行语义折叠，将琐碎内容合并为 1-2 条高度概括的新事件文本。


4. **事务提交与软归档**：开启 SQLite 事务，在 `memory_events` 中插入合并生成的新事件，同时将作为原料的旧 10 条事件的 `is_archived` 字段更新为 1。

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
| **IDLE** | 前台闲置 180s 且未归档事件过量 | **DREAMING** | 提取最低权重冷数据，调用 LLM 折叠，开启 SQLite 事务读写。 |
| **DREAMING** | 事务提交成功 / 异常捕获 | **IDLE** | 释放做梦期间占用的内存资源。 |

### 3.2 异常边界与兜底策略

* **持久化死锁与冷启动重置**：在 App 根组件挂载（如 React Native `useEffect`）时，强制执行 `is_locked = false` 的清理操作，确保在任何异常闪退或非正常退出后，下次启动能正常解除锁定。


* **巩固中途超时降级**：若异步巩固请求超过 30 秒（超时定时器触发），直接强制修改 `is_locked = false` 并丢弃本次快照，不累加计数，等待下一个 10 轮周期，防止污染本地数据。


* **做梦时系统强杀**：所有做梦和折叠逻辑中的数据库写入必须包裹在标准的 SQLite `TRANSACTION` 中。由于该机制限制在前台闲置时触发，一旦遭遇用户突然退台或系统杀进程，数据将自动 `ROLLBACK`，保证本地数据一致性。

---

## 4. 数据模型契约 (Data Schema)

### 4.1 SQLite 表结构定义

```sql
-- 表一：记忆片段表
CREATE TABLE IF NOT EXISTS memory_fragments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "index" INTEGER NOT NULL,          -- 关联的父级记忆事件ID
    timestamp TEXT NOT NULL,           -- ISO8601 格式
    summary TEXT NOT NULL,             -- 50字以内概要
    emotion TEXT NOT NULL              -- 情绪状态描述
);

-- 表二：记忆事件表
CREATE TABLE IF NOT EXISTS memory_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "index" INTEGER NOT NULL,          -- 索引记忆事件自增ID
    event_text TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    active_weight INTEGER NOT NULL CHECK(active_weight BETWEEN 1 AND 100),
    last_accessed TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0 -- 0:活跃, 1:软归档
);
CREATE INDEX IF NOT EXISTS idx_events_archive_weight ON memory_events(is_archived, active_weight);

-- 表三：系统元数据表 (用于持久化计数与锁状态)
CREATE TABLE IF NOT EXISTS system_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

```

### 4.2 记忆衰减数学公式

活跃权重采用**小时级**惰性求值，读取时计算。设 $W_{last}$ 为最后一次调用时的权重，$t_{\Delta}$ 为当前时间与 `last_accessed` 的**小时数差值**（浮点数），$d$ 为艾宾浩斯衰减系数（默认值 `0.06`）：

$$W_{now} = \max\left(1, \left\lfloor W_{last} \cdot e^{-d \cdot t_{\Delta}} \right\rfloor\right)$$

### 4.3 app_config (可快捷自定义配置项)

```json
{
  "prompts": {
    "system_prompt": "你是一个温柔的情感陪伴助手...",
    "extraction_prompt": "提取后台记忆与用户信息...",
    "state_injection_template": "基础信息：{{nickname}}，所在地{{location}}...",
    "dream_consolidation_prompt": "折叠以下琐碎记忆...",
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
    "context_active_events_limit": 10
  },
  "weight_decay": {
    "ebbinghaus_decay_rate": 0.06,
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


* **When**: 用户发送第 10 轮消息（完全未提及布丁）。生成前台回复后，触发异步提取，模型返回 4.4 节格式的数据，其中包含新提取的 `new_fragment` 且 `target_event_text` 字段有内容。


* **Then**:
1. 本地立即将锁状态置为 `is_locked = true`。


2. 事务执行成功：`memory_events` 中成功插入新行并生成自增 `id = 18`；`memory_fragments` 中成功写入一条 `index = 18` 的记录。


3. `user_info` 进行 Merge 后，“布丁”信息完好无损地保留，且新合并的信息成功更新。


4. 本地计数器重置为 0，`is_locked` 释放为 `false`。





### AC 2: “灵光一闪”扰动事件的过滤抽取与 Token 截断

* **Given**: 数据库内存有一条被标记为活跃、权重为 20（低活跃度）的事件 `A`，和一条已归档的事件 `B`（`is_archived = 1`）。
* **When**: 用户发送消息。系统拼装上下文。
* **Then**:
1. 系统检索非归档高权重事件的同时，通过“灵光一闪” SQL 命中了冷记忆事件 `A`，成功排除了归档事件 `B`。
2. 该事件被作为随机扰动项注入上下文的记忆区。


3. 若拼装时检测到字数超标，系统能自动剔除其他非命中的低权重活跃事件，优先确保事件 `A` 及最近 15 轮对话在总字数限制内。



### AC 3: 空库冷启动与默认占位符降级验证

* **Given**: 数据库处于刚创建的空库状态，`user_info` 无任何实质数据。
* **When**: 用户发送第一条消息：“你好”。
* **Then**:
1. 系统不抛出 `undefined` 异常，渲染 Prompt 状态区时检测到数据为空，触发降级。


2. 自动应用解耦配置中的 `cold_start_template`。对于未定义的字段，拼装层使用 `default_placeholders`（如“未知地方”）进行防崩替换。
3. 前台模型接收到引导性的 System Prompt，并以一种引导性、探索性的人设态度进行安全的首轮回复。