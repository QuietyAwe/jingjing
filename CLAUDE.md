# CLAUDE.MD

> **[CRITICAL]** 本文件为项目单一事实来源 (SSOT)。代码变更必须同步更新本文档。

## 一、System Rules

* **Role**: 资深全栈架构师 & 敏捷研发专家。
* **Docs-First**: 每次对话首步：校验并对齐本文件状态。
* **RFC 变更拦截**: 遇逻辑修改或新需求，执行串行流：
    1. `分析`：简述变更对现有系统的影响。
    2. `更新业务`：修改【二、Architecture Contracts】或【三、Changelog】。
    3. `更新排期`：修改【四、Task Board】，标记状态。
    4. `阻塞挂起`：向用户确认："文档已更新，是否开始开发？"
* **变更完成检查**: 每次代码修改完成后，立即更新 CLAUDE.md，不得跳过。

---

## 二、 Architecture Contracts

### 2.1 MVP 边界
* **目标**：基于端侧 SQLite 的隐私型情感陪伴记忆引擎，实现增量补式短期记忆巩固、冷记忆随机扰动（灵光一闪）、前台闲置智能"做梦"与冷启动兼容。
* **边界**：
    - **IN**：本地 SQLite 存储、纯 JS 分词检索（优先事件，未命中再检索片段）、艾宾浩斯衰减、15 轮滑动窗口、异步巩固流（10 轮触发）、前台闲置做梦流（180s 触发）、冷启动降级、参数配置解耦、前台/后台双模型路由。
    - **OUT**：云端同步、多账号体系、服务端存储、多模态（语音/图片）记忆、原生 C/C++ SQLite FTS5 深度分词。

### 2.2 State Machine
* **主干链路**：`IDLE` → `RETRIEVING` → `CHAT_PENDING` → `CONSOLIDATING` → `IDLE`
* **旁路**：`IDLE` → `DREAMING` → `IDLE`
* **异常处理**：
    - 持久化死锁：App 启动时强制 `is_locked = false` 清理
    - 巩固超时（30s）：强制解锁，丢弃快照，不累加计数
    - 做梦被强杀：SQLite 事务自动 ROLLBACK
    - 空库冷启动：应用 `cold_start_template` + `default_placeholders`

### 2.2.1 消息发送结构（缓存优化）
```
messages = [
  { role: "system", content: systemPrompt },  // 稳定，高缓存命中
  { role: "system", content: statePrompt },   // 巩固窗口内稳定
  ...chatHistory,                              // 前缀相对稳定
  { role: "system", content: memoryPrompt },  // 每次检索可能变化
  { role: "user", content: latestMessage },   // 每次新的
]
```
* 系统人设独立发送，前缀缓存100%命中
* 状态区在10轮巩固窗口内不变，缓存命中
* 记忆区每次检索可能变化，放历史之后

### 2.3 Data Schema
```json
// memory_events: 记忆事件表
// { id: INTEGER PK, "index": INTEGER, event_text: TEXT, timestamp: TEXT, active_weight: INTEGER (1-100), last_accessed: TEXT, is_archived: INTEGER (0/1), priority: INTEGER (1-9) }
// INDEX: idx_events_archive_weight ON (is_archived, active_weight)

// memory_fragments: 记忆片段表
// { id: INTEGER PK, "index": INTEGER (父事件ID), timestamp: TEXT (ISO8601), summary: TEXT (50字内), emotion: TEXT, priority: INTEGER (1-9) }

// system_metadata: 系统元数据表
// { key: TEXT PK, value: TEXT }
// 常用 key：is_locked, turn_counter, last_emotion, default_event_id

// user_info: 用户信息表（由巩固流增量 Merge 维护）
// { basic_identity, preferences, social_graph, psycho_state, life_quests }

// behavior_schedule: 行为时间表（AI每周自动生成）
// { id: INTEGER PK, week_start: TEXT (ISO日期), day_of_week: INTEGER (0-6), time_slot: INTEGER (0-4), activity: TEXT, created_at: TEXT }
// INDEX: idx_schedule_week ON (week_start)
// 时段：0=早(6-9), 1=上午(9-12), 2=午(12-15), 3=下午(15-18), 4=晚(18-23)
```

### 2.4 Tech Stack
```
Expo SDK 54 / TypeScript 5.9 / expo-sqlite v16 / Zustand v5 / openai v4 / dayjs / AsyncStorage / react-native-sse / DeepSeek API
```

### 2.5 Project Structure
```
app/                # expo-router 文件路由（tabs/ 聊天+设置，_layout 根布局）
src/db/             # SQLite 连接、建表、CRUD 查询
src/memory/         # 记忆引擎：分词、检索、衰减、巩固、做梦
src/llm/            # LLM 调用：前台（非流式）、后台（JSON mode）
src/prompt/         # Prompt 拼装、配置管理、模板渲染
src/store/          # Zustand 状态：聊天、设置、元数据
src/theme/          # 主题系统：色板（浅色/深色）、useTheme hook
src/types/          # TypeScript 类型定义
```

### 2.6 Prompt 模板体系
* **通用变量**：`[user]`（用户名）、`[now]`（当前时间），所有模板可用
* **记忆事件专用**：`[time]`（相对时间，如"前两个月"）
* **状态区变量**：`{{nickname}}`、`{{likes}}`、`{{current_status}}` 等15个，空字段自动隐藏
* **记忆区变量**：`{{event_list}}`、`{{epiphany}}`
* **上下文模板**：`{{{system_prompt}}}`、`{{{state_info}}}`、`{{{memory_events}}}`（已弃用，改为分条发送）

---

## 三、 Changelog
> 每更新2个版本后归档最早的版本至 `ARCHIVE.md`

| 版本 | 日期 | 模块 | 业务变更说明 | 关联任务 |
| --- | --- | --- | --- | --- |
| v1.0 | 07-14 | 全局 | 初始化工作台，确立 MVP 边界，完成技术栈选型与任务拆解 | P1-1 |
| v1.0 | 07-14 | 基建 | 完成 P1 基建：项目初始化、TS 类型、SQLite 建表、配置模块 | P1-1 ~ P1-4 |
| v1.0 | 07-14 | 数据层 | 完成 P2 数据层：全部 CRUD 含增量 Merge | P2-1 ~ P2-4 |
| v1.0 | 07-14 | 记忆引擎 | 完成 P3 记忆引擎：分词、衰减、检索+灵光一闪、Prompt 拼装 | P3-1 ~ P3-4 |
| v1.0 | 07-14 | 聊天流 | 完成 P4 聊天流：冷启动、滑动窗口、LLM 调用、端到端串联 | P4-1 ~ P4-4 |
| v1.0 | 07-14 | 巩固流 | 完成 P5 巩固流：轮次计数、后台 LLM 提取、双重关联写入、超时兜底 | P5-1 ~ P5-4 |
| v1.0 | 07-14 | 做梦流 | 完成 P6 做梦流：闲置检测、冷数据 LLM 折叠、事务+软归档 | P6-1 ~ P6-3 |
| v1.0 | 07-14 | UI | 完成 P7 UI：聊天界面、冷启动体验、设置页（提示词编辑+用户画像+记忆统计） | P7-1 ~ P7-3 |
| v1.0 | 07-14 | 修复 | 对齐原始设计文档：状态区情绪注入、占位符替换、模板渲染、灵光闪现触发 | 偏差修复 |
| v1.0 | 07-15 | 修复 | API 兼容：RN 非流式降级、baseURL 修正、冷启动系统提示词修复 | Bug Fix |
| v1.1 | 07-15 | UI | 长按菜单：气泡长按弹出操作（复制/删除/编辑/重新生成/编辑并重新发送） | 聊天交互 |
| v1.1 | 07-15 | UI | 夜间模式：深色/浅色主题切换，Zustand 持久化偏好，全局色板系统 | 外观 |
| v1.1 | 07-15 | 架构 | Prompt 架构重构：系统人设独立 + 上下文模板（{{{system_prompt}}} 等变量控制拼装顺序） | Prompt 系统 |
| v1.1 | 07-15 | UI | 设置页拆分：系统人设 / 上下文模板 / 状态区注入 / 记忆区注入 / 记忆事件格式 五个独立编辑区 | 设置页 |
| v1.1 | 07-15 | 持久化 | 聊天记录全量持久化（AsyncStorage + Zustand persist），不再丢失历史 | 数据持久化 |
| v1.1 | 07-15 | 调试 | 开发者调试面板：所有 API 请求完整日志输出，含巩固流和做梦流 | 调试工具 |
| v1.2 | 07-17 | 架构 | 缓存优化：system/state/memory 拆分发送，提高前缀缓存命中率 | 缓存优化 |
| v1.2 | 07-17 | UI | 提示词变量选择器：点击插入变量，支持通用变量和模板专用变量 | 变量系统 |
| v1.2 | 07-17 | UI | 状态区空字段自动隐藏：无数据的字段整行移除，段落标题同步清理 | 状态区优化 |
| v1.2 | 07-17 | 构建 | EAS 云构建：配置 Android APK 构建流程 | 构建部署 |
| v1.2 | 07-17 | 修复 | 状态区空字段隐藏逻辑修复：两遍处理确保空段落标题也被正确移除 | Bug Fix |
| v1.2 | 07-17 | 功能 | 流式输出：设置页开关 + foreground.ts 支持 SSE 流式/非流式切换 | 流式输出 |
| v1.2 | 07-17 | UI | 消息气泡分段：AI 回复按段落分割成多条气泡，上下文仍为一条完整消息 | 气泡分段 |
| v1.2 | 07-17 | 功能 | DeepSeek API 支持：thinking 参数配置（默认关闭） | DeepSeek |
| v1.3 | 07-17 | 修复 | 轮次计数优化：延迟一轮计数，最后一条消息不参与计数 | 计数逻辑 |
| v1.3 | 07-17 | UI | 事件详情弹窗：点击事件查看详情和关联的记忆片段 | 事件管理 |
| v1.3 | 07-17 | UI | 调试面板优化：移除系统提示词模块，打开时自动滚动到底部 | 调试工具 |
| v1.3 | 07-17 | 功能 | 思考模式：设置页开关 + 思考内容提取 + 可展开思考气泡 | 思考模式 |
| v1.3 | 07-17 | UI | 记忆区时间戳：模板底部显示当前日期时间（中文周几） | 时间显示 |
| v1.4 | 07-17 | 修复 | 移除 setDecay 调用（权重与衰减设置已删除） | Bug Fix |
| v1.4 | 07-17 | 架构 | 行为时间表：AI每周自动生成作息表，注入当前状态替代情绪标签 | 行为时间表 |
| v1.5 | 07-17 | 架构 | 默认事件"日常闲聊"：巩固流兜底，不参与检索，减少垃圾信息 | 默认事件 |
| v1.5 | 07-17 | 优化 | 检索策略：优先检索事件，未命中再检索片段，节省查询开销 | 检索优化 |
| v1.6 | 07-17 | 修复 | 深夜时段状态：0-6点随机显示"准备睡觉/被叫醒/迷糊中/做梦/失眠" | 深夜优化 |
| v1.6 | 07-17 | 修复 | SQL列名修复：memory_fragments 表列名为 "index" 而非 event_index | Bug Fix |
| v1.6 | 07-17 | 优化 | 提取提示词：对话历史作为独立消息发送，提高缓存命中率 | 缓存优化 |

---

## 四、 Task Board
> **状态**：`待启动` / `进行中` / `已完成` / `废弃`
> 已完成超过 10 条时，已完成任务归档至 `ARCHIVE.md`

> 历史已完成任务（P1-1 ~ P7-3 + 偏差修复）已归档至 ARCHIVE.md

| 编号 | 模块 | 任务描述 (AC: 验收标准) | 状态 |
| --- | --- | --- | --- |
| **P8-1** | 集成 | AC1 验证：巩固流端到端（预置 social_graph → 对话 10 轮 → 验证 Merge 完整性） | 待启动 |
| **P8-2** | 集成 | AC2 验证：灵光一闪 + Token 截断（预置事件 → 验证抽取/剔除逻辑） | 待启动 |
| **P8-3** | 集成 | AC3 验证：空库冷启动（清库 → 发送"你好" → 验证无 undefined + 引导人设） | 待启动 |
| **P9-1** | UI | 提示词编辑器重构：三级分组、废弃字段移除、说明文案、输入框布局优化 | 进行中 |
| **P10-1** | 功能 | 行为时间表：AI每周自动生成作息表，注入当前状态替代情绪标签 | 已完成 |
| **P10-2** | 功能 | 默认事件"日常闲聊"：巩固流兜底，排除检索/TopN/灵光一闪 | 已完成 |
| **P10-3** | 优化 | 提取提示词优化：对话历史作为独立消息，提高缓存命中率 | 已完成 |

---

## 五、 Active Issues

> 当前 bug / 技术债 / 待决策项。解决后删除。
> 可避免踩坑的经验归档至 `ARCHIVE.md`

| # | 描述 | 状态 |
| --- | --- | --- |
