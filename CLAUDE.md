# SYSTEM RULES(CLAUDE.MD)

> **[CRITICAL]** 本文件为项目单一事实来源 (SSOT)。严格禁止在未同步更新本文档前修改任何代码。

## 一、 核心执行指令 (System Directives)

* **Role**: 资深全栈架构师 & 敏捷研发专家。
* **Docs-First**: 每次对话首步：校验并对齐本文件状态。
* **RFC 变更拦截**: 遇逻辑修改或新需求，严格执行串行流：
    1. `分析`：简述变更对现有系统的影响。
    2. `更新业务`：修改【二、架构契约】与【三、Changelog】。
    3. `更新排期`：修改【四、Task Board】，标记状态。
    4. `阻塞挂起`：停止输出，向用户提问：“文档已更新，是否按此排期开始开发？”
* **日志视角隔离 (Log Strict Separation)**:
    * `Changelog` = 业务级 (What/Why)。
    * `Dev Log` = 工程级 (How)。**禁止双表复读。**

---

## 二、 架构契约 (Architecture & Data Contracts)
> **[Agent 维护]** 需随业务变更实时自更新。请基于用户初始需求填充下方 `[...]` 内容。

### 2.1 MVP 边界
* **目标**：基于端侧 SQLite 的隐私型情感陪伴记忆引擎，实现增量补式短期记忆巩固、冷记忆随机扰动（灵光一闪）、前台闲置智能”做梦”与冷启动兼容。
* **边界**：
    - **IN**：本地 SQLite 存储、纯 JS 分词检索、艾宾浩斯衰减、15 轮滑动窗口、异步巩固流（10 轮触发）、前台闲置做梦流（180s 触发）、冷启动降级、参数配置解耦、前台/后台双模型路由。
    - **OUT**：云端同步、多账号体系、服务端存储、多模态（语音/图片）记忆、原生 C/C++ SQLite FTS5 深度分词。

### 2.2 核心状态机与异常兜底 (State Machine)
* **主干链路**：`IDLE` → `RETRIEVING` → `CHAT_PENDING` → `CONSOLIDATING` → `IDLE`；旁路 `IDLE` → `DREAMING` → `IDLE`
* **异常处理**：
    - 持久化死锁：App 根组件挂载时强制 `is_locked = false` 清理
    - 巩固超时（30s）：强制解锁，丢弃快照，不累加计数
    - 做梦被系统强杀：SQLite 事务自动 ROLLBACK，保证数据一致性
    - 空库冷启动：应用 `cold_start_template` + `default_placeholders` 防 undefined 崩溃

### 2.3 核心数据模型 (Data Schema)
```json
// memory_fragments: 记忆片段表
// { id: INTEGER PK, “index”: INTEGER (父事件ID), timestamp: TEXT (ISO8601), summary: TEXT (50字内), emotion: TEXT }

// memory_events: 记忆事件表
// { id: INTEGER PK, “index”: INTEGER, event_text: TEXT, timestamp: TEXT, active_weight: INTEGER (1-100), last_accessed: TEXT, is_archived: INTEGER (0/1) }
// INDEX: idx_events_archive_weight ON (is_archived, active_weight)

// system_metadata: 系统元数据表
// { key: TEXT PK, value: TEXT }

// user_info: 用户信息表（由巩固流增量 Merge 维护）
// 完整结构对齐 PRD 4.4 节 updated_user_info JSON 契约
```

---

## 三、 Changelog (业务变更记录)

> **视角**：What & Why。

| 版本 | 日期 | 模块 | 业务变更说明 (What/Why) | 关联任务 |
| --- | --- | --- | --- | --- |
| v1.0 | 2026-07-14 | 全局 | 初始化工作台，确立 MVP 边界，完成技术栈选型与任务拆解 | P1-1 |
| v1.0 | 2026-07-14 | 基建 | 完成 P1 基建阶段：项目初始化、TS 类型定义、SQLite 建表、配置模块 | P1-1 ~ P1-4 |
| v1.0 | 2026-07-14 | 数据层 | 完成 P2 数据层：全部 CRUD 操作（metadata/user_info/events/fragments）含增量 Merge | P2-1 ~ P2-4 |
| v1.0 | 2026-07-14 | 记忆引擎 | 完成 P3 记忆引擎：中文分词、衰减计算、本地检索+灵光一闪、Prompt 拼装与截断 | P3-1 ~ P3-4 |
| v1.0 | 2026-07-14 | 聊天流 | 完成 P4 聊天流：冷启动降级、滑动窗口、LLM 流式调用、端到端串联 + Notion 风 UI | P4-1 ~ P4-4 |

---

## 四、 Task Board (项目排期)

> **状态枚举**：`待启动` / `进行中` / `待确认` / `已完成` / `[变更重构]` / `[废弃]`

| 编号 | 版本 | 模块 | 任务描述 (AC: 验收标准) | 状态 |
| --- | --- | --- | --- | --- |
| **P1-1** | v1.0 | 基建 | **初始化 Expo 项目**：`npx create-expo-app` 创建 TS 项目；安装 expo-sqlite、zustand、dayjs、openai、async-storage、expo-router；配置 tsconfig 路径别名。 (AC: `npx expo start` 成功启动，Expo Go 可连接) | 已完成 |
| **P1-2** | v1.0 | 类型 | **定义核心 TS 类型**：对齐 PRD 4.4 节 JSON 契约，定义 UserInfo、MemoryEvent、MemoryFragment、NewFragment、SystemMetadata、AppConfig 等接口；导出为 `src/types/schema.ts`。 (AC: 所有 PRD 4.4 节示例 JSON 可通过 `as` 断言无 TS 编译错误) | 已完成 |
| **P1-3** | v1.0 | 数据库 | **SQLite 建表与连接**：实现 `src/db/connection.ts` 连接单例；`src/db/schema.ts` 执行 PRD 4.1 节三条 CREATE TABLE + 索引；App 启动时自动建表。 (AC: 启动后用 expo-sqlite 同步 API 查询 `sqlite_master` 返回 3 张表 + 1 个索引) | 已完成 |
| **P1-4** | v1.0 | 配置 | **app_config 模块**：实现 `src/prompt/config.ts`，从本地 JSON 加载 PRD 4.3 节配置；提供类型安全的 getter；缺失字段用 default_placeholders 兜底。 (AC: 访问 `config.prompts.cold_start_template` 返回正确字符串；故意删一个字段不报 undefined 错误) | 已完成 |
| **P2-1** | v1.0 | 数据层 | **system_metadata CRUD**：实现 `src/db/queries.ts` 中 getMeta/setMeta 函数；读写 key-value 对。 (AC: 写入 `turn_counter=5` 后读回 `5`；写入 `is_locked=true` 后读回 `true`) | 已完成 |
| **P2-2** | v1.0 | 数据层 | **user_info 读写与增量 Merge**：实现 getUserInfo / mergeUserInfo；merge 逻辑：对 likes、dislikes、social_graph、life_quests 等数组执行值去重追加，非数组字段直接覆盖。 (AC: 初始写入含 `"布丁"` 的 social_graph；merge 新数据后 `"布丁"` 仍存在且新数据已追加) | 已完成 |
| **P2-3** | v1.0 | 数据层 | **memory_events CRUD**：实现 insertEvent / getTopActive(limit) / getArchivedRandom / updateWeight / softArchive；支持 active_weight 范围校验（1-100）。 (AC: 插入事件后通过 getTopActive(10) 可查到；softArchive 后 is_archived=1，getTopActive 不再返回) | 已完成 |
| **P2-4** | v1.0 | 数据层 | **memory_fragments CRUD**：实现 insertFragment / getFragmentsByEventId；timestamp 自动填充 ISO8601。 (AC: 插入 fragment(index=18) 后按 eventId 查回 1 条记录，timestamp 为合法 ISO8601) | 已完成 |
| **P3-1** | v1.0 | 记忆引擎 | **中文分词与停用词过滤**：实现 `src/memory/tokenize.ts`；纯 JS 实现，无原生依赖；内置中文停用词表（约 100 词）；输入一段话输出去重关键词数组，上限 3 个。 (AC: 输入"我今天因为房租发愁"→ 输出含"房租""发愁"，不含"我""因为"；超过 3 个词时截断) | 已完成 |
| **P3-2** | v1.0 | 记忆引擎 | **艾宾浩斯衰减计算器**：实现 `src/memory/decay.ts`；公式 `W_now = max(1, floor(W_last * e^(-0.06 * t_hours)))`；输入 last_weight、last_accessed 时间戳，输出当前权重。 (AC: weight=100, 刚访问 → 返回 100；weight=100, 10小时前 → 返回 `max(1, floor(100*e^(-0.6)))` = 54) | 已完成 |
| **P3-3** | v1.0 | 记忆引擎 | **本地检索 + 灵光一闪**：实现 `src/memory/retrieval.ts`；流程：调用 tokenize → SQL LIKE 查询 Top3 命中事件 → 刷新命中事件 weight=100 + last_accessed → 用 decay 计算所有事件实时权重 → 取 Top10 高权重 → 随机抽 1 条 weight<40 的冷记忆。 (AC: 数据库含 5 条事件，搜索命中 2 条后这 2 条 weight 变为 100；返回结果含 10 条高权重 + 1 条随机冷记忆) | 已完成 |
| **P3-4** | v1.0 | 记忆引擎 | **Prompt 拼装与 Token 截断**：实现 `src/prompt/assembler.ts`；按顺序拼接：系统人设 + 状态区（用户信息/情绪）+ 记忆区（Top10 + 1 条扰动）+ 15 轮历史；超限时从低权重记忆事件开始剔除，优先保护最近对话与状态区。 (AC: 正常拼装含所有区段；注入超长记忆事件后，低权重事件被剔除，15 轮对话完整保留) | 已完成 |
| **P4-1** | v1.0 | 聊天流 | **冷启动检测与降级**：在 Prompt 拼装前检测 user_info 是否为空；空库时应用 cold_start_template，缺失字段用 default_placeholders 替换，不输出空标签。 (AC: 空库发送"你好"→ 返回的 system prompt 包含引导性模板文字，无 undefined/null 占位符) | 已完成 |
| **P4-2** | v1.0 | 聊天流 | **15 轮滑动窗口**：实现 `src/store/chatStore.ts`；维护消息数组；仅保留最近 15 轮（30 条）；超出时从头部移除最旧消息。 (AC: 连续发送 20 条消息后，store 中只保留最后 30 条；第 1 条消息已被移除) | 已完成 |
| **P4-3** | v1.0 | 聊天流 | **前台 LLM 客户端**：实现 `src/llm/client.ts` + `src/llm/foreground.ts`；用 openai SDK 调用 gpt-4o（temperature=0.7）；支持流式输出；处理网络错误返回友好降级文案。 (AC: 发送一段 prompt 收到流式回复并逐字渲染；断网时不崩溃，显示"网络异常"提示) | 已完成 |
| **P4-4** | v1.0 | 聊天流 | **端到端聊天主流程串联**：在聊天界面整合完整流程：用户输入 → tokenize → 检索 → 冷启动判断 → Prompt 拼装 → LLM 调用 → 流式渲染回复 → 消息存入 chatStore。 (AC: 首次打开发送"你好"→ AI 以引导性人设回复；第二次发送含关键词的消息 → 回复中体现记忆区内容) | 已完成 |
| **P5-1** | v1.0 | 巩固流 | **轮次计数与锁机制**：每次前台回复成功后 turn_counter+1 并持久化到 system_metadata；App 启动时强制 is_locked=false。 (AC: 连续对话 3 轮后 turn_counter=3；手动杀 App 重启后 is_locked 为 false) | 待启动 |
| **P5-2** | v1.0 | 巩固流 | **后台提取 LLM 客户端**：实现 `src/llm/background.ts`；调用 gpt-4o-mini（temperature=0.0, json_object 模式）；传入 user_info + 10 轮快照；解析返回的 updated_user_info + new_fragment。 (AC: 传入示例快照 → 返回合法 JSON，包含 updated_user_info 和 new_fragment 两个顶层字段) | 待启动 |
| **P5-3** | v1.0 | 巩固流 | **双重关联写入事务**：实现 `src/memory/consolidation.ts`；SQLite 事务内依次执行：① merge updated_user_info → ② 若 target_event_text 非空则 insertEvent 获取 new_event_id，否则挂靠最近活跃事件 → ③ insertFragment(new_event_id, summary, emotion)。 (AC: 按 AC1 验证——social_graph 中"布丁"保留；memory_events 新增 id=18；memory_fragments 新增 index=18 的记录) | 待启动 |
| **P5-4** | v1.0 | 巩固流 | **30 秒超时与计数归零**：触发巩固时启动 30s 定时器；成功完成或超时均释放锁、清零计数器；超时时丢弃快照不写入。 (AC: 模拟超时（断网）→ 30s 后 is_locked 恢复 false，turn_counter=0，数据库无脏数据) | 待启动 |
| **P6-1** | v1.0 | 做梦流 | **前台闲置检测**：监听 AppState；用户无操作满 180s 且 is_archived=0 的事件数 > 50 时触发。 (AC: 前台闲置 180s + 数据库有 55 条活跃事件 → 触发；不足 50 条时不触发) | 待启动 |
| **P6-2** | v1.0 | 做梦流 | **冷数据 LLM 折叠**：取 active_weight 最低的 10 条冷事件；调用 LLM 语义合并为 1-2 条概括事件。 (AC: 传入 10 条琐碎事件 → 返回 1-2 条概括性文本) | 待启动 |
| **P6-3** | v1.0 | 做梦流 | **事务提交与软归档**：SQLite 事务内：① insertEvent（折叠结果）→ ② 将原 10 条事件 is_archived=1。异常时自动 ROLLBACK。 (AC: 做梦完成后，新事件出现且权重为 100；原 10 条事件 is_archived 均为 1；getTopActive 不再返回旧事件) | 待启动 |
| **P7-1** | v1.0 | UI | **聊天界面**：实现 `app/(tabs)/index.tsx`；消息列表（ChatBubble）+ 底部输入栏（InputBar）；支持流式文字逐字渲染；空状态显示欢迎语。 (AC: 打开 App 看到欢迎语；发送消息后出现用户气泡 + AI 气泡逐字出现) | 待启动 |
| **P7-2** | v1.0 | UI | **冷启动首次对话体验**：空库首次打开时，AI 以"刚刚相识"的引导性人设主动提问；不出现任何 undefined/空标签。 (AC: 清空数据库后首次打开 → AI 回复内容体现好奇、温柔态度，引导用户介绍自己) | 待启动 |
| **P7-3** | v1.0 | UI | **设置页面**：实现 `app/(tabs)/settings.tsx`；展示当前 user_info 摘要；显示记忆事件数量统计；提供"清除所有数据"按钮。 (AC: 设置页显示用户昵称/城市；点击清除后数据库为空，返回聊天页触发冷启动) | 待启动 |
| **P8-1** | v1.0 | 集成 | **AC1 验证：巩固流端到端**：模拟完整场景——数据库预置含"布丁"的 social_graph → 对话满 10 轮 → 验证锁定/解锁、事务写入、数据 Merge 完整性。 (AC: 按 PRD AC1 全部 4 条 Then 逐一验证通过) | 待启动 |
| **P8-2** | v1.0 | 集成 | **AC2 验证：灵光一闪 + Token 截断**：数据库预置活跃事件 A(weight=20) + 归档事件 B → 发送消息 → 验证 A 被抽取、B 被排除、超限时低权重事件被剔除。 (AC: 按 PRD AC2 全部 3 条 Then 逐一验证通过) | 待启动 |
| **P8-3** | v1.0 | 集成 | **AC3 验证：空库冷启动**：清空数据库 → 发送"你好" → 验证无 undefined 异常、应用 cold_start_template、AI 以引导性人设回复。 (AC: 按 PRD AC3 全部 3 条 Then 逐一验证通过) | 待启动 |

---

## 五、 Dev Log (开发日志)

> **视角**：How。

### [[2026-07-14]] 技术栈选型

* **状态**：已确定，待启动开发。
* **工程细节 (How)**：

#### 技术栈总览

| 层级 | 选型 | 版本 | 选型理由 |
| --- | --- | --- | --- |
| **语言** | TypeScript | ^5.x | PRD 数据模型复杂（嵌套 JSON 契约），TS 类型系统可防运行时 undefined 崩溃，且 AI 生成代码质量更高 |
| **框架** | Expo (React Native) | SDK 52+ | PRD 明确指定；托管构建免 Xcode/Android Studio；跨平台一套代码；生态成熟坑少 |
| **路由** | expo-router | ^4.x | 基于文件的路由，零配置；Expo 官方推荐；适合聊天 App 的简单导航结构 |
| **本地数据库** | expo-sqlite | ^15.x | PRD 要求本地 SQLite；Expo 官方维护；支持同步 API 方便做事务控制；无需 expo-dev-client |
| **状态管理** | Zustand | ^5.x | 极简 boilerplate（单文件 store）；无 Provider 包裹；适合本项目多独立 store（user_info / chat / memory）的场景 |
| **日期处理** | dayjs | ^1.x | 轻量（2KB）；不可变 API；处理 PRD 中 ISO8601 时间戳与小时级衰减计算 |
| **LLM 调用** | openai | ^4.x | 官方 SDK，支持流式响应与 JSON mode；PRD 中 foreground/background 双模型路由均需调用 OpenAI API |
| **本地存储** | @react-native-async-storage/async-storage | ^2.x | 存储 turn_counter / is_locked 等轻量状态键值对；Expo 兼容 |
| **前台状态监听** | react-native (AppState) | 内置 | 监听前台闲置 180s 触发做梦流；无需额外依赖 |

#### 不选的方案及原因

| 候选方案 | 排除理由 |
| --- | --- |
| Flutter/Dart | 语言生态不如 RN；AI 代码生成训练数据量偏少，Vibe Coding 体验差 |
| 原生 iOS + Android | 双端维护成本高；与"代码优先、AI 生成"需求矛盾 |
| Redux Toolkit | 样板代码多；本项目无需复杂中间件链 |
| Drift (SQLite ORM) | 过度抽象；PRD 要求裸 SQL 控制（LIKE 查询、事务、索引），ORM 反而碍事 |
| Realm | 非 SQLite 内核；PRD 明确指定 SQLite 表结构与 SQL 语法 |

#### 项目结构规划

```
Jingjing/
├── app/                    # expo-router 文件路由
│   ├── (tabs)/             # Tab 导航
│   │   ├── index.tsx       # 聊天主界面
│   │   └── settings.tsx    # 设置页
│   ├── _layout.tsx         # 根布局 + 冷启动锁清理
│   └── chat.tsx            # 聊天详情页
├── src/
│   ├── db/
│   │   ├── schema.ts       # 建表 SQL & 迁移
│   │   ├── queries.ts      # 封装 PRD 中所有 SQL 查询
│   │   └── connection.ts   # SQLite 连接单例
│   ├── memory/
│   │   ├── tokenize.ts     # 纯 JS 中文分词 + 停用词过滤
│   │   ├── retrieval.ts    # 本地检索 Top3 + 灵光一闪
│   │   ├── consolidation.ts # 异步巩固流（双重关联写入）
│   │   ├── decay.ts        # 艾宾浩斯衰减计算
│   │   └── dreaming.ts     # 前台闲置做梦流
│   ├── prompt/
│   │   ├── assembler.ts    # Prompt 拼装与 Token 截断
│   │   └── config.ts       # app_config 读取与默认值
│   ├── llm/
│   │   ├── client.ts       # OpenAI SDK 初始化
│   │   ├── foreground.ts   # 前台聊天模型调用
│   │   └── background.ts   # 后台提取模型调用（JSON mode）
│   ├── store/
│   │   ├── chatStore.ts    # 聊天状态（消息列表、滑动窗口）
│   │   ├── userStore.ts    # 用户信息缓存
│   │   └── metaStore.ts    # 系统元数据（计数器、锁）
│   ├── components/
│   │   ├── ChatBubble.tsx
│   │   └── InputBar.tsx
│   └── types/
│       └── schema.ts       # TS 类型定义（对齐 PRD 4.4 节 JSON 契约）
├── assets/                 # 字体、图片
├── app.json                # Expo 配置
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

#### 构建与运行

- **开发**：`npx expo start` → Expo Go 扫码调试
- **构建**：`eas build -p ios / android`（EAS Build 云构建，无需本地 Xcode/Android Studio）
- **测试**：Jest + @testing-library/react-native