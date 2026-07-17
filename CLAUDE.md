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

---

## 二、 Architecture Contracts

### 2.1 MVP 边界
* **目标**：基于端侧 SQLite 的隐私型情感陪伴记忆引擎，实现增量补式短期记忆巩固、冷记忆随机扰动（灵光一闪）、前台闲置智能"做梦"与冷启动兼容。
* **边界**：
    - **IN**：本地 SQLite 存储、纯 JS 分词检索、艾宾浩斯衰减、15 轮滑动窗口、异步巩固流（10 轮触发）、前台闲置做梦流（180s 触发）、冷启动降级、参数配置解耦、前台/后台双模型路由。
    - **OUT**：云端同步、多账号体系、服务端存储、多模态（语音/图片）记忆、原生 C/C++ SQLite FTS5 深度分词。

### 2.2 State Machine
* **主干链路**：`IDLE` → `RETRIEVING` → `CHAT_PENDING` → `CONSOLIDATING` → `IDLE`
* **旁路**：`IDLE` → `DREAMING` → `IDLE`
* **异常处理**：
    - 持久化死锁：App 启动时强制 `is_locked = false` 清理
    - 巩固超时（30s）：强制解锁，丢弃快照，不累加计数
    - 做梦被强杀：SQLite 事务自动 ROLLBACK
    - 空库冷启动：应用 `cold_start_template` + `default_placeholders`

### 2.3 Data Schema
```json
// memory_events: 记忆事件表
// { id: INTEGER PK, "index": INTEGER, event_text: TEXT, timestamp: TEXT, active_weight: INTEGER (1-100), last_accessed: TEXT, is_archived: INTEGER (0/1) }
// INDEX: idx_events_archive_weight ON (is_archived, active_weight)

// memory_fragments: 记忆片段表
// { id: INTEGER PK, "index": INTEGER (父事件ID), timestamp: TEXT (ISO8601), summary: TEXT (50字内), emotion: TEXT }

// system_metadata: 系统元数据表
// { key: TEXT PK, value: TEXT }

// user_info: 用户信息表（由巩固流增量 Merge 维护）
// { basic_identity, preferences, social_graph, psycho_state, life_quests }
```

### 2.4 Tech Stack
```
Expo SDK 54 / TypeScript 5.9 / expo-sqlite v16 / Zustand v5 / openai v4 / dayjs / AsyncStorage
```

### 2.5 Project Structure
```
app/                # expo-router 文件路由（tabs/ 聊天+设置，_layout 根布局）
src/db/             # SQLite 连接、建表、CRUD 查询
src/memory/         # 记忆引擎：分词、检索、衰减、巩固、做梦
src/llm/            # LLM 调用：前台（非流式）、后台（JSON mode）
src/prompt/         # Prompt 拼装、配置管理、模板渲染
src/store/          # Zustand 状态：聊天、设置、元数据
src/types/          # TypeScript 类型定义
```

---

## 三、 Changelog
> 超过 15 行时归档最早的记录至 `ARCHIVE.md`

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

---

## 五、 Active Issues

> 当前 bug / 技术债 / 待决策项。解决后删除。可避免踩坑的经验归档至 `ARCHIVE.md`

| # | 描述 | 状态 |
| --- | --- | --- |
| 1 | React Native fetch 不支持 ReadableStream，前台 LLM 已改非流式，逐字输出效果丢失 | 已降级 |
