# ARCHIVE.MD
> 从 CLAUDE.md 迁移的已完成记录。

---

## Changelog（归档）

| 版本 | 日期 | 模块 | 业务变更说明 | 关联任务 |
| --- | --- | --- | --- | --- |
| — | — | — | — | — |

---

## Task Board（归档）

| 编号 | 模块 | 任务描述 | 完成日期 |
| --- | --- | --- | --- |
| P1-1 | 基建 | 初始化 Expo 项目：TS + expo-sqlite + zustand + openai + expo-router | 07-14 |
| P1-2 | 类型 | 定义核心 TS 类型：UserInfo / MemoryEvent / MemoryFragment / AppConfig 等 | 07-14 |
| P1-3 | 数据库 | SQLite 建表与连接：connection 单例 + schema.ts + 自动建表 | 07-14 |
| P1-4 | 配置 | app_config 模块：本地 JSON 加载 + 类型安全 getter + default_placeholders 兜底 | 07-14 |
| P2-1 | 数据层 | system_metadata CRUD：getMeta / setMeta | 07-14 |
| P2-2 | 数据层 | user_info 读写与增量 Merge：数组去重追加，非数组覆盖 | 07-14 |
| P2-3 | 数据层 | memory_events CRUD：insertEvent / getTopActive / getArchivedRandom / softArchive | 07-14 |
| P2-4 | 数据层 | memory_fragments CRUD：insertFragment / getFragmentsByEventId | 07-14 |
| P3-1 | 记忆引擎 | 中文分词与停用词过滤：纯 JS，内置停用词表，上限 3 词 | 07-14 |
| P3-2 | 记忆引擎 | 艾宾浩斯衰减计算器：W_now = max(1, floor(W_last * e^(-0.06 * t))) | 07-14 |
| P3-3 | 记忆引擎 | 本地检索 + 灵光一闪：tokenize → LIKE Top3 → 刷新权重 → TopN + 概率冷记忆 | 07-14 |
| P3-4 | 记忆引擎 | Prompt 拼装与 Token 截断：系统人设 + 状态区 + 记忆区 + 15 轮历史 | 07-14 |
| P4-1 | 聊天流 | 冷启动检测与降级：空库应用 cold_start_template + default_placeholders | 07-14 |
| P4-2 | 聊天流 | 15 轮滑动窗口：保留最近 30 条消息，超出从头部移除 | 07-14 |
| P4-3 | 聊天流 | 前台 LLM 客户端：OpenAI SDK 调用，非流式（RN 兼容），超时降级 | 07-14 |
| P4-4 | 聊天流 | 端到端串联：用户输入 → 检索 → 冷启动判断 → Prompt → LLM → 渲染 | 07-14 |
| P5-1 | 巩固流 | 轮次计数与锁：turn_counter 持久化，启动时强制 is_locked=false | 07-14 |
| P5-2 | 巩固流 | 后台提取 LLM：gpt-4o-mini JSON mode，30s AbortController 超时 | 07-14 |
| P5-3 | 巩固流 | 双重关联写入事务：merge user_info → insertEvent → insertFragment | 07-14 |
| P5-4 | 巩固流 | 30s 超时与计数归零：成功/超时均释放锁+清零 | 07-14 |
| P6-1 | 做梦流 | 前台闲置检测：AppState + 180s timer + getActiveCount > 50 | 07-14 |
| P6-2 | 做梦流 | 冷数据 LLM 折叠：10 条最低权重事件 → LLM 合并为 1-2 条 | 07-14 |
| P6-3 | 做梦流 | 事务提交与软归档：insertEvent + softArchiveBatch，异常 ROLLBACK | 07-14 |
| P7-1 | UI | 聊天界面：消息列表 + 输入栏 + 流式渲染 + 空状态欢迎语 | 07-14 |
| P7-2 | UI | 冷启动首次对话：AI 以引导性人设主动提问，无 undefined | 07-14 |
| P7-3 | UI | 设置页：用户画像 + 记忆统计 + 系统提示词编辑 + 清除数据 | 07-14 |
| — | 修复 | 状态区情绪注入、[user][time]占位符替换、模板渲染、灵光闪现触发、配置驱动、清库函数 | 07-14 |

---

## 踩坑经验（归档）

> Bug 成因、重大技术选型或架构变更的原因，避免后人踩坑。

| 日期 | 经验 | 原因 |
| --- | --- | --- |
| 07-15 | RN 前台 LLM 必须用非流式 | RN fetch 不支持 ReadableStream，OpenAI SDK `for await` 报 "no body" |
| 07-15 | OpenAI SDK baseURL 不能带 `/v1` | SDK 自动拼 `/v1`，带了会变成 `/v1/v1/chat/completions` |
| 07-15 | 冷启动 prompt 必须拼 system_prompt | 只用 cold_start_template 会导致 AI 不知道自己是谁 |
| 07-14 | streamChat 签名要和调用方对齐 | 函数改了签名但调用方没更新，导致 messages 参数错位 |
