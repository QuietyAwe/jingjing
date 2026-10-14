# 核心代码逻辑评审报告（记忆引擎 + 外围模块）

> **第一轮修复状态（2026-10-11）：8/8 已修复**，随 v1.0.7 OTA 发布。
> **第二轮修复状态（2026-10-11）：10/10 已修复**，随 v1.0.8 OTA 发布。
> **第三轮（体验问题）修复状态（2026-10-11）：3/3 已修复**，随 v1.0.9 OTA 发布。`npx tsc --noEmit` 通过、lint 零告警。
> 第二轮覆盖：游戏四件套（20问/炸弹/快艇/真心话）、心情动态、前台 LLM、备份导入导出、配置持久化、日历语义、ID/文本工具。

## 第三轮：体验问题修复（用户实测反馈）

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 19 | **补巩固把刚发的消息和 AI 回复也巩固了**，且看起来「第一条消息之后才开始」 | ① 触发点在聊天页挂载（用户进来就是发消息的），且每批都重读**实时**消息数组——补巩固跑好几批 LLM 期间，新发的消息被卷进批次当场提取；② 水合等待窗口进一步把起跑推迟 | ① 触发提前到 App 启动（`_layout.tsx`，等 `loadApiKey` 后立刻跑）；② `runCatchUpConsolidation` 改为**固定积压快照**：入口先取 `boundaryTs`，整个过程只处理启动前的历史，中途新消息一律不进批次，留给常规巩固流 |
| 20 | **记忆片段里没有 [time] 了，提取引擎把详细日期写进去了** | 「## 当前时间」给了精确日期后，模型顺势把事发时间写成「10月10日」而不用 `[time]` 占位符——写死的日期过几天就成了错误信息 | ① 提取指令显式约束「gist/summary/states 的事发时间必须写 [time]，禁止写具体日期」；② 三条提取链路（巩固/游戏/动态）统一加 `ensureTimePlaceholder` 兜底：整段无 [time] 时把第一处日期词换回 `[time]`（保留「约好10月20日见面」这类关键细节里的未来日期） |
| 21 | **非流式模式键盘早弹**：对话还没完全弹出就聚焦了 | 自动聚焦挂在 `isLoading` 结束 +80ms，但非流式回复是逐条动画弹出的（每段 0.5~3s，最长约 15s），键盘在动画中途升起 | 动画节奏抽成共享 `revealStepMs`/`revealTotalMs`（ChatBubble 与聚焦共用同口径），聚焦延时 = 80ms + 该回复的逐条动画总时长；流式模式/单段回复算出 0，退化为原行为 |

### 整体评估

⚠️ [Good / Risky]

整体架构清晰，注释与设计文档高度一致，边界处理细致（巩固游标按消息 id 锚定、片段批量查询防 N+1、提取结果归一化兜底）。但核心记忆链路存在 2 个直接影响体验的逻辑错误：改期事件会让 AI 反复说出「已经过去了」的错误关心；检索命中的记忆在 Token 截断时反而最先被丢弃。另有若干数据一致性与并发隐患（重置不彻底、挂载清锁、Map 重提不更新位置）需修复。

### Issue清单

#### 1. 状态机字段丢失 — 改期事件被注入「已经过去了」的错误关心 🔴

**Location:** `src/db/queries.ts#L288-L294`
**Analysis:** `mergeEvents` 重建事件对象时有两处错误：① `status` 只要不是 `archived` 就原样保留 —— 若事件已进入 `caring`（已过期未提起）而用户重新约定了时间（LLM 提取到同一文本、新 `due_time` 在未来），状态仍是 `caring`；② `expired_at` 字段在重建时被丢弃。后果：`src/memory/eventChecker.ts` 的 `buildEventNudges` 走到 `event.status === "caring"` 分支，对一个**尚未到期**的事件持续注入「「xx」已经过去了…找个契机关心一下」的隐形提示词；且 `careStart = dayjs(event.expired_at ?? event.due_time)` 回退到未来的 `due_time`，48h 归档窗口永远凑不满，事件永远卡在 caring。属于功能性错误，用户可直接感知（AI 反复提起已改期的约定）。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\db\queries.ts

// ------ ORIGINAL CODE ------
      const prev = map.get(text);
      map.set(text, {
        text,
        due_time: due.toISOString(),
        created_at: prev?.created_at ?? nowIso,
        status: prev && prev.status !== "archived" ? prev.status : "upcoming",
      });
// --------------------------
// ------ NEW CODE ----------
      const prev = map.get(text);
      const stillOverdue = !due.isAfter(nowIso);
      map.set(text, {
        text,
        due_time: due.toISOString(),
        created_at: prev?.created_at ?? nowIso,
        // 改期到未来 = 事情还没发生：必须回到 upcoming，否则残留的 caring 会让
        // buildEventNudges 对未到期事件反复注入「已经过去了」的关心提示；
        // 仍在过去才保留 caring 与 expired_at（48h 关心窗口需要连续计算）
        status: prev?.status === "caring" && stillOverdue ? "caring" : "upcoming",
        ...(prev?.status === "caring" && stillOverdue && prev.expired_at
          ? { expired_at: prev.expired_at }
          : {}),
      });
// --------------------------
```

#### 2. 计算用了陈旧快照 — 刚被唤起的记忆在截断时最先被丢弃 🔴

**Location:** `src/memory/retrieval.ts#L150-L153`
**Analysis:** 第 4 步 `updateWeight(event.id, 100)` 把命中事件刷成 100/now，但 `hitEvents` 数组里的对象是第 2/3 步 SELECT 出的**旧快照**（`active_weight`/`last_accessed` 均为命中前的值）。`hitWeighted` 用 `e.last_accessed` 计算 `live_weight`，一条 3 天没被想起、刚被当前话题唤起的记忆会算出约 24 的权重，而同期 `ambient` 记忆（第 5 步 `getAllActive()` 在刷新后读取）是 ~100。`truncateToFit` 按权重从低到高「降级→删除」，结果**检索命中最相关的记忆反而最先被降级成 gist、最先整块删除**，与「命中事件在前（相关）」的设计相反。命中越多、上下文越长时越容易触发。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\memory\retrieval.ts

// ------ ORIGINAL CODE ------
  const hitWeighted = hitEvents.map((e) => ({
    ...e,
    live_weight: calculateWeight(e.active_weight, e.last_accessed, e.priority, e.memory_kind),
  }));
// --------------------------
// ------ NEW CODE ----------
  // updateWeight 刚把命中事件刷成 100/now，但 hitEvents 是刷新前 SELECT 出的旧对象，
  // 继续用 e.last_accessed 会把「刚被想起」算成低权重：截断时命中记忆反而最先被丢
  const hitAt = new Date().toISOString();
  const hitWeighted = hitEvents.map((e) => ({
    ...e,
    active_weight: 100,
    last_accessed: hitAt,
    live_weight: calculateWeight(100, hitAt, e.priority, e.memory_kind),
  }));
// --------------------------
```

#### 3. 重置不彻底 — 清除数据后残留幽灵对局 🟡

**Location:** `src/db/queries.ts#L611-L619`
**Analysis:** `clearAllData` 删除了记忆、画像、动态等 8 张表，**唯独漏掉 `game_sessions`**（注释声称「清除所有数据」）。设置页重置后，旧对局记录（尤其 `status='playing'` 的未完局）仍在库里：`app/chat.tsx#L576-L579` 的「恢复未结束的对局」逻辑会把一个消息已被清空的幽灵对局恢复进 UI；`getRecentSecrets` 也会继续返回旧谜底，影响题材去重。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\db\queries.ts

// ------ ORIGINAL CODE ------
  db.runSync("DELETE FROM memory_fragments");
  db.runSync("DELETE FROM memory_events");
  db.runSync("DELETE FROM user_info");
  db.runSync("DELETE FROM system_metadata");
  db.runSync("DELETE FROM behavior_schedule");
  db.runSync("DELETE FROM moment_comments");
  db.runSync("DELETE FROM moments");
  db.runSync("DELETE FROM post_plan");
// --------------------------
// ------ NEW CODE ----------
  db.runSync("DELETE FROM memory_fragments");
  db.runSync("DELETE FROM memory_events");
  db.runSync("DELETE FROM game_sessions");
  db.runSync("DELETE FROM user_info");
  db.runSync("DELETE FROM system_metadata");
  db.runSync("DELETE FROM behavior_schedule");
  db.runSync("DELETE FROM moment_comments");
  db.runSync("DELETE FROM moments");
  db.runSync("DELETE FROM post_plan");
// --------------------------
```

#### 4. 并发隐患 — 挂载即清锁，巩固进行中可被并发触发 🟡

**Location:** `src/store/metaStore.ts#L23-L35`
**Analysis:** `load()` 每次执行都无条件 `setMeta("is_locked", "false")`，但 `load()` 由聊天页挂载触发（`app/chat.tsx#L554-L557`），并非仅 App 冷启动 —— 用户在 30s 巩固窗口内退出再进入聊天页，锁被强制释放，此时 `turn_counter` 若已达阈值，新一轮 `runConsolidation` 会与在途巩固并发：两批提取重复写入记忆、`advanceCursor`/`reset()` 互相覆盖游标与计数。注释「启动时强制清理锁」的意图是防崩溃死锁，实现范围过宽。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\store\metaStore.ts

// ------ ORIGINAL CODE ------
export const useMetaStore = create<MetaState>((set, get) => ({
  turnCounter: 0,
  isLocked: false,

  load: () => {
    const counter = getMeta("turn_counter");
    // 启动时强制清理锁，防止上次崩溃导致死锁
    setMeta("is_locked", "false");
    set({
      turnCounter: counter ? parseInt(counter, 10) : 0,
      isLocked: false,
    });
  },
// --------------------------
// ------ NEW CODE ----------
// 进程内只强制清锁一次（防上次崩溃死锁）。load 会在聊天页每次挂载时执行，
// 无条件清锁会把进行中的巩固的锁误释放，导致并发巩固互相覆盖游标与计数
let startupLockCleared = false;

export const useMetaStore = create<MetaState>((set, get) => ({
  turnCounter: 0,
  isLocked: false,

  load: () => {
    const counter = getMeta("turn_counter");
    if (!startupLockCleared) {
      startupLockCleared = true;
      setMeta("is_locked", "false");
    }
    set({
      turnCounter: counter ? parseInt(counter, 10) : 0,
      isLocked: getMeta("is_locked") === "true",
    });
  },
// --------------------------
```

#### 5. 上限裁剪与「重提刷新」语义冲突 — 刚刷新的条目反被裁掉 🟡

**Location:** `src/db/queries.ts#L266-L275`
**Analysis:** `mergeStates` 用 `map.set(text, …)` 刷新重提的状态，但 JS `Map.set` 对已存在的键**不改变插入位置**，最后 `Array.from(map.values()).slice(-20)` 按插入序裁剪 —— 一个 3 周前首次加入、今天被重新提起（`created_at` 已刷新、应留在 7 天活跃期内）的状态仍留在队首，条目超过 20 时会优先被裁掉，「同一状态被重提会刷新时效」在上限附近失效。同样的问题存在于 `mergeSocialGraph`（`Map.set` + `.slice(-30)`）、`mergeEvents`（`Map.set` + `.slice(-20)`）、`mergeArray`（`Set.add` 保留首次插入位置 + `.slice(-cap)`）。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\db\queries.ts

// ------ ORIGINAL CODE ------
  const mergeStates = (a: StateItem[], b: string[] | undefined): StateItem[] => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((s) => [s.text, s]));
    for (const raw of b) {
      const text = raw?.trim();
      if (!text) continue;
      map.set(text, { text, created_at: nowIso });
    }
    return Array.from(map.values()).slice(-20);
  };
// --------------------------
// ------ NEW CODE ----------
  const mergeStates = (a: StateItem[], b: string[] | undefined): StateItem[] => {
    if (!b || b.length === 0) return a;
    const map = new Map(a.map((s) => [s.text, s]));
    for (const raw of b) {
      const text = raw?.trim();
      if (!text) continue;
      // 先删再插：Map.set 对已存在的键不改变插入位置，直接 set 会让「刚被重提刷新」
      // 的旧条目留在队首，slice(-cap) 按插入序裁剪时反而把它裁掉
      //（mergeSocialGraph / mergeEvents / mergeArray 同理，重提前先 delete）
      map.delete(text);
      map.set(text, { text, created_at: nowIso });
    }
    return Array.from(map.values()).slice(-20);
  };
// --------------------------
```

#### 6. 性能 — 每条游戏消息查一次库，getHistory 全流程放大 🟡

**Location:** `src/store/chatStore.ts#L92-L105`
**Analysis:** `mergeEndedGameMessages` 在遍历**每条**带 `game_id` 的消息时调用 `getGameSessionById`（一次同步 SQLite 查询），而同一对局的所有消息查回的是同一行。`getHistory()` 在一轮对话中被调用多次（发送前拼上下文、计数判断、游戏 AI 发言各一次），一局 20 问几十条消息会被放大成上百次同步查询，主线程卡顿。结果只依赖 `game_id`，按对局缓存即可。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\store\chatStore.ts

// ------ ORIGINAL CODE ------
  const result: ChatMessage[] = [];
  for (const m of msgs) {
    if (!m.game_id) {
      result.push(m);
      continue;
    }
    const group = groups.get(m.game_id)!;
    const isFirst = m.id === group[0].id;
    const session = getGameSessionById(m.game_id);
    // result_note 只在对局结束时写入：即便旧数据 status 还卡在 playing，写了结果就当已结束
    if (!session || (session.status === "playing" && !session.result_note)) {
// --------------------------
// ------ NEW CODE ----------
  const result: ChatMessage[] = [];
  // 每个对局的 session 只查一次：原实现对每条游戏消息查一次库，
  // 而 getHistory 一轮对话会被调用多次，长对局会放大成上百次同步 SQLite 查询
  const sessionCache = new Map<number, ReturnType<typeof getGameSessionById>>();
  for (const m of msgs) {
    if (!m.game_id) {
      result.push(m);
      continue;
    }
    const group = groups.get(m.game_id)!;
    const isFirst = m.id === group[0].id;
    if (!sessionCache.has(m.game_id)) {
      sessionCache.set(m.game_id, getGameSessionById(m.game_id));
    }
    const session = sessionCache.get(m.game_id) ?? null;
    // result_note 只在对局结束时写入：即便旧数据 status 还卡在 playing，写了结果就当已结束
    if (!session || (session.status === "playing" && !session.result_note)) {
// --------------------------
```

#### 7. 游标迁移兜底错误 — 可能把全部历史重复提取一遍 🟡

**Location:** `src/memory/consolidation.ts#L59-L67`
**Analysis:** `resolveCursor` 的旧下标游标迁移分支中，当 `messages[legacy - 1]` 取不到（老设备升级后用户删过消息导致下标越界，或 meta 值损坏）时直接 `return 0`，意味着「从头开始巩固」—— 全部历史被重新提取一遍，产生大量重复记忆，与本文件自述的「彻底定位不到就当都巩固过了，宁可少提取一次」原则相悖（id 锚点分支就是按此原则返回 `messages.length`）。迁移分支的兜底应同样保守：截断到 `messages.length`。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\memory\consolidation.ts

// ------ ORIGINAL CODE ------
  // 旧版本用数组下标做游标：迁移成「那条之后」，老设备平滑过渡
  const legacy = parseInt(getMeta("last_consolidated_index") ?? "0", 10);
  const anchor = messages[legacy - 1];
  if (anchor) {
    setMeta("last_consolidated_id", anchor.id);
    setMeta("last_consolidated_at", anchor.timestamp);
    return legacy;
  }
  return 0;
// --------------------------
// ------ NEW CODE ----------
  // 旧版本用数组下标做游标：迁移成「那条之后」，老设备平滑过渡
  const legacy = parseInt(getMeta("last_consolidated_index") ?? "0", 10);
  const anchor = messages[legacy - 1];
  if (anchor) {
    setMeta("last_consolidated_id", anchor.id);
    setMeta("last_consolidated_at", anchor.timestamp);
    return legacy;
  }
  // 锚点定位不到（消息被删导致下标越界 / meta 损坏）：宁可少提取，
  // 也不能返回 0 从头重提——那会把全部历史重复提取一遍，产生重复记忆
  return legacy > 0 ? Math.min(legacy, messages.length) : 0;
// --------------------------
```

#### 8. 兜底路径漏写元数据 — 可能重复创建「日常闲聊」事件 🟡

**Location:** `src/memory/consolidation.ts#L254-L262`
**Analysis:** 兜底分支在 `getDefaultEventId()` 为空时 `insertEvent("日常闲聊", …)` 新建默认事件，但**不写入 `system_metadata.default_event_id`**。只要该路径执行过一次，后续每次兜底都会再建一个同名事件（`getDefaultEventId` 依旧返回 null），事件表逐渐膨胀并污染检索候选与记忆区 Top N。对比 `clearAllData` 的同名逻辑（建完即写 meta），此处遗漏。

**Fix Recommendation:**

```typescript
// FILEPATH: d:\Jingjing\src\memory\consolidation.ts

// ------ ORIGINAL CODE ------
        } else {
          // 兜底：挂靠默认事件"日常闲聊"
          const defaultId = getDefaultEventId();
          if (defaultId) {
            targetEventId = defaultId;
          } else {
            targetEventId = insertEvent("日常闲聊", 50, 1, "daily", batchEndTs);
          }
        }
// --------------------------
// ------ NEW CODE ----------
        } else {
          // 兜底：挂靠默认事件"日常闲聊"
          const defaultId = getDefaultEventId();
          if (defaultId) {
            targetEventId = defaultId;
          } else {
            targetEventId = insertEvent("日常闲聊", 50, 1, "daily", batchEndTs);
            // 记下元数据，否则下次兜底又会再建一个「日常闲聊」
            setMeta("default_event_id", String(targetEventId));
          }
        }
// --------------------------
```

---

## 第二轮评审（外围模块）

**范围**：游戏四件套（20问/数字炸弹/快艇骰子/真心话大冒险）、心情动态、前台 LLM、备份导入导出、配置持久化、日历语义、ID/文本工具、设置页。
**结论**：⚠️ 整体良好，游戏状态机（纯函数层）质量高、边界防御到位；发现 10 项问题，集中在**备份数据完整性**与**边界输入**，全部已修复。

### Issue清单（第二轮）

| # | 问题 | 严重度 | 位置 | 修复要点 |
|---|------|--------|------|----------|
| 9 | **备份遗漏 4 张表**：`game_sessions`/`moments`/`moment_comments`/`post_plan` 不在导出/导入范围，恢复备份后动态、评论、发帖计划、对局记录全部丢失；导入也不清这 4 张表，导致新旧数据混杂 | 🔴 | `src/utils/backup.ts#L13-L24` | 接口加 4 个可选表字段，导出/导入全量覆盖，导入前先清表 |
| 10 | **导入丢失 `memory_kind`**：`memory_events` 恢复语句不含 `memory_kind` 列，episode 共同经历（游戏/动态）退化成 daily，按天衰减与权重下限 15 失效，很快跌出灵光一闪池 | 🔴 | `src/utils/backup.ts#L119-L129` | INSERT 补 `memory_kind` 列，旧备份无此字段回退 `daily` |
| 11 | **备份携带巩固锁**：导出时若正处于巩固中，`system_metadata.is_locked="true"` 被一并备份；导入后锁永远解不开（除非重启），巩固流永久卡死 | 🟡 | `src/utils/backup.ts#L150-L156` | 恢复 `system_metadata` 后强制 `is_locked=false` |
| 12 | **导入后配置缓存不刷新**：`config_overrides` 被备份覆盖，但 `prompt/config.ts` 的内存缓存与设置页 state 不重载，显示旧值且新提示词不生效（直到重启） | 🟡 | `app/(tabs)/settings.tsx#L1095-L1103` | 导入成功后 `loadConfigOverrides()` + 重载阈值/路由/人设 state |
| 13 | **题材去重列表被污染**：`getRecentSecrets` 不分游戏类型，数字炸弹的 `secret`（炸弹数字，如 "37"）混进 20问「已用谜底」清单，污染出题 prompt | 🟡 | `src/db/queries.ts#L693-L699` | SQL 加 `game_type = 'twenty_questions'` 过滤 |
| 14 | **设置页「已修改」标记误报**：`getConfigDefault` 缺 `system_prompt`/`memory_injection_template`/`memory_event_template`/`moment_generation_prompt`/`moment_comment_prompt`，比对恒为空串，这些字段永远显示「已修改」 | 🟡 | `src/prompt/config.ts#L67-L87` | 缺省表补齐全部可编辑模板 key |
| 15 | **空 API Key 误判已配置**：`hasApiKey()` 只判 `!== null`，设置页清空 Key 保存空串后返回 true，`getClient()` 随后抛「not initialized」 | 🟡 | `src/llm/client.ts#L49-L52` | 追加 `&& _apiKey !== ""` |
| 16 | **窗口被 system 消息挤占**：`getHistory` 先 `slice(-len)` 再过滤 system 消息，游戏结束横幅等占掉窗口名额，实际送进模型的历史不足 10 轮 | 🟡 | `src/store/chatStore.ts#L185-L197` | 先过滤（保留游戏摘要）再截窗 |
| 17 | **AI 猜数可能重复报数**：`aiGuess` 中点已猜时偏移 `mid±1`，偏移值可能也猜过，白费一轮甚至重蹈炸弹 | 🟡 | `src/game/bomb/ai.ts#L16-L35` | 抽 `pickUntried`：中点优先，已猜则线性扫区间找首个未猜数 |
| 18 | **发帖重试语义错误**：LLM 失败后保留 pending 但删掉 `fireAt`，下轮重进会**重掷「临场放弃」骰子**——想发没发成的计划可能被误判成「想了想又没发」 | 🟡 | `src/moments/engine.ts#L115-L157` | 失败保留 `fireAt` 原样重试；`postFromPlan` 返回是否成功，成功才清触发时刻 |

### 各模块质量观察（无问题，供参考）

- **游戏纯函数层**（`bomb/engine`、`yacht/engine`、`yacht/rules`、`truthDare/engine`）：状态机边界防御到位（重复填分拒绝、终局拒绝写入、待答题保护），计分逻辑精确无 LLM 依赖，`replaceBank` 对 pendingIndex 的处理有明确注释与正确语义。
- **前台 LLM**（`foreground.ts`）：流式静默/整体双超时 + 统一 `finish()` 收口设计良好；`request.catch(() => {})` 防竞速落败的 unhandled rejection 是正确写法；超时不降级重试的判断准确。
- **20问判定**（`judge.ts`）：`correct === true` 严格比较防「假胜」、意图白名单校验、`ruleJudge` 兜底含防卡死注释，质量高。
- **日历语义**（`holidays.ts`）：静态调休表 + 回退周几判断，边界正确（2026-10-11 周日 → 正确输出「国庆节调休上班」语义已验证）。
- **ID 生成**（`utils/id.ts`）：`timestamp-seq-random` 三段式防同帧撞 id，注释解释了旧实现缺陷，正确。
