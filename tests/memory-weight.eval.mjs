// 记忆强化时序评估：验证「常提的事保持记忆」与「误报的事不被长期提醒」。
// 复跑：node --experimental-strip-types tests/memory-weight.eval.mjs
// 分词/停用词/屏蔽词取自真实源码；衰减公式按 src/memory/decay.ts 复刻（项目无 node_modules，别名模块无法直接 import）。
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "/workspace/jingjing";
const OUT = `${ROOT}/docs/memory-weight-eval.html`;
const { tokenize, scoreOverlap } = await import(pathToFileURL(`${ROOT}/src/memory/tokenize.ts`).href);

const tsrc = readFileSync(`${ROOT}/src/memory/tokenize.ts`, "utf8");
const STOP = new Set(new Function("return [" + tsrc.match(/const STOP_WORDS = new Set\(\[([\s\S]*?)\]\);/)[1] + "]")());
const isBlockedGram = (g, words) => words.some((w) => w.includes(g) || g.includes(w));
const BLOCKED = ["阿柚", "私藏"];
const STOP_MULTI = [...STOP].filter((w) => w.length >= 2 && /^[一-鿿]+$/.test(w)).sort((a, b) => b.length - a.length);
const stripStop = (text) => STOP_MULTI.reduce((t, w) => t.split(w).join(""), text);

// ── 记忆库（字段化，对应真实 schema 的 event_text / gist / summary / keywords）──
// group: hot 常提高频 · lowfreq 低频提起 · stopped 提过之后停 · never 从未被提 · ritual 程式化问候
const MEM = [
  { id: 1, name: "巷口面馆", group: "hot", event: "巷口面馆", alias: "", gist: "[time]晚上[user]加完班去巷口面馆吃了一碗牛肉面", summary: "[time]晚上[user]说加班结束绕去巷口面馆，点了牛肉面，汤头很暖，觉得一天的压力都被抚平了，还说下次要带[ai]一起去", kw: "巷口面馆 牛肉面 吃面 面馆 加班 夜宵" },
  { id: 2, name: "妈妈做的番茄炒蛋", group: "stopped", event: "妈妈做的番茄炒蛋", alias: "", gist: "[time][user]说想吃妈妈做的番茄炒蛋", summary: "[time][user]聊起小时候妈妈做的番茄炒蛋，说外面怎么都做不出那个味道，有点想家", kw: "妈妈 母亲 我妈 老妈 番茄炒蛋 想家 老家" },
  { id: 3, name: "加班到很晚", group: "stopped", event: "加班到很晚", alias: "", gist: "[time][user]连着一周加班到很晚", summary: "[time][user]说项目赶稿连着一周加班到很晚，颈椎疼，语气很疲惫但没抱怨，只说想早点睡", kw: "加班 熬夜 项目 赶稿 疲惫 颈椎 压力" },
  { id: 4, name: "周末去西山", group: "lowfreq", event: "周末去西山", alias: "", gist: "[time][user]周末去爬了西山", summary: "[time][user]说周末一个人去爬西山，山顶风很大，拍了张照片，觉得好久没这么松快", kw: "西山 爬山 周末 山顶 照片" },
  { id: 5, name: "团子橘猫", group: "stopped", event: "团子（橘猫）", alias: "", gist: "[time][user]说团子又把桌上的杯子推下去了", summary: "[time][user]家养了只橘猫叫团子，爱推桌上的东西，[user]嘴上嫌弃其实很宠", kw: "团子 橘猫 猫 宠物 推杯子" },
  { id: 6, name: "被领导批评", group: "never", event: "被领导批评", alias: "", gist: "[time][user]被领导当众批评了", summary: "[time][user]说方案被领导当众否了，觉得委屈又不好意思跟同事说，回家跟[ai]讲了很久", kw: "领导 老板 批评 方案 委屈 当众 骂" },
  { id: 7, name: "感冒发烧", group: "never", event: "感冒发烧", alias: "", gist: "[time][user]感冒发烧请假在家", summary: "[time][user]说感冒发烧到38度，一个人躺了一天没人照顾，语气有点低落", kw: "感冒 发烧 生病 请假 38度" },
  { id: 8, name: "和小陈吵架", group: "never", event: "和小陈吵架", alias: "", gist: "[time][user]跟朋友小陈闹了别扭", summary: "[time][user]说和小陈因为一件小事吵了架，其实不全是对方的问题，但拉不下脸先开口", kw: "小陈 朋友 吵架 闹别扭" },
  { id: 9, name: "手冲咖啡", group: "never", event: "学做手冲咖啡", alias: "", gist: "[time][user]开始学手冲咖啡", summary: "[time][user]买了一套手冲器具，第一次冲出来的咖啡太酸，说要慢慢练", kw: "手冲 咖啡 拿铁 器具 太酸" },
  { id: 10, name: "童年外婆家", group: "never", event: "童年外婆家", alias: "", gist: "[time][user]聊起小时候在外婆家过暑假", summary: "[time][user]说小时候暑假都在外婆家，院子里有棵枇杷树，那是记忆里最安稳的夏天", kw: "外婆 童年 暑假 枇杷树 院子" },
  { id: 11, name: "睡前晚安", group: "ritual", event: "睡前晚安", alias: "", gist: "[time][user]睡前跟[ai]说晚安", summary: "[time][user]那阵子每晚睡前都会来跟[ai]说一声晚安，偶尔还会多聊两句才睡", kw: "晚安 睡前 道别 每晚" },
  { id: 12, name: "打算去大理", group: "never", event: "打算去大理", alias: "", gist: "[time][user]说想请年假去大理", summary: "[time][user]说想请年假去大理住几天，看看洱海，还没订机票", kw: "大理 旅行 洱海 年假 机票" },
  { id: 13, name: "早安问候", group: "ritual", event: "早安问候", alias: "", gist: "[time][user]早上跟[ai]打招呼", summary: "[time][user]有阵子每天早上会先发一句早上好再出门", kw: "早上好 早安 问候 出门" },
];

// ── 检索 ──
const ALL = ["gist", "summary", "kw"], KEY = ["kw"];
function retrieve(q, o) {
  const kw = tokenize(o.strip ? stripStop(q) : q, 16, (g) => isBlockedGram(g, BLOCKED));
  if (!kw.length) return { kw, hits: [] };
  const has = (s) => kw.some((k) => s.includes(k));
  const pick = (e, fs) => fs.map((f) => e[f] ?? "").join(" ") || (e.kw ? "" : e.gist);
  const rank = (cands, textOf) => {
    const min = o.shortStrict && kw.length <= 2 ? kw.length : 1;
    return cands
      .map((item) => ({ item, s: scoreOverlap(textOf(item), kw) }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s || a.item.id - b.item.id)
      .map((x) => x.item);
  };
  let hits = rank(MEM.filter((e) => has(`${e.event} ${e.alias}`)), (e) => `${e.event} ${e.alias}`).slice(0, 3);
  if (!hits.length) hits = rank(MEM.filter((e) => has(pick(e, o.fields))), (e) => pick(e, o.fields)).slice(0, 3);
  return { kw, hits };
}
const RETRIEVE = {
  old: { fields: ALL, strip: false, shortStrict: false },  // 改动前：全字段、命中即算
  new: { fields: KEY, strip: true, shortStrict: true },     // 改动后：只认标签、停用词先剥离
};

// ── 时间线：7 天 × 5 轮 = 35 轮 ──
// role 用于模拟会话时机信号（开场/道别），intent 是「这句话真的在提哪件事」的人工标注，仅用于评分。
const HOT_Q = ["还记得巷口那家面馆吗", "上次那家面馆的牛肉面", "再去巷口面馆吧", "晚上去吃面吧", "巷口面馆的汤头真暖", "那家面馆还开着吗", "又想去吃面了"];
const OTHER_Q = [
  { q: "周末去爬了西山", intent: ["周末去西山"] },
  { q: "又加班到很晚", intent: ["加班到很晚"] },
  { q: "我妈做的番茄炒蛋", intent: ["妈妈做的番茄炒蛋"] },
  { q: "上次去西山拍的照片", intent: ["周末去西山"] },
  { q: "团子又把杯子推下去了", intent: ["团子橘猫"] },
  { q: "老妈的拿手菜", intent: ["妈妈做的番茄炒蛋"] },
  { q: "还想去西山", intent: ["周末去西山"] },
];
// 真实闲聊里带通用词，旧检索（全字段）会撞上 summary 的模板话，新检索（只认标签）不会
const CHAT_Q = ["觉得有点累", "有点无聊", "觉得还行吧", "有点困了", "觉得有点烦", "有点想歇会儿", "觉得今天还行"];
const T = [];
for (let d = 0; d < 7; d++) {
  const base = d * 24;
  T.push({ t: base + 8, role: "greeting", q: d % 2 === 0 ? "晚上好" : "早上好", intent: [] });
  T.push({ t: base + 12.5, role: "recall", q: HOT_Q[d], intent: ["巷口面馆"] });
  T.push({ t: base + 14, role: "chat", q: CHAT_Q[d], intent: [] });
  const o = OTHER_Q[d];
  T.push({ t: base + 20, role: "recall", q: o.q, intent: o.intent });
  T.push({ t: base + 23, role: "farewell", q: "晚安", intent: [] });
}
const END = 7 * 24;

// ── 衰减（复刻 decay.ts：daily, priority 5 → 0.025/小时，指数衰减，下限 1）──
const RATE = 0.02 * (2 - (5 - 1) * (1.5 / 8));
const decay = (w, hours) => Math.max(1, Math.floor(w * Math.exp(-RATE * hours)));

// ── 策略 ──
const POLICIES = [
  { id: "A", label: "A 现状：旧检索 + 命中即 100", ret: "old", bump: () => 100, gate: false },
  { id: "B", label: "B 旧检索 + 累进 +35", ret: "old", bump: (w) => Math.min(100, w + 35), gate: false },
  { id: "B2", label: "B2 旧检索 + 累进 +60", ret: "old", bump: (w) => Math.min(100, w + 60), gate: false },
  { id: "C", label: "C 新检索 + 命中即 100（推荐）", ret: "new", bump: () => 100, gate: false },
  { id: "D", label: "D 新检索 + 累进 +35", ret: "new", bump: (w) => Math.min(100, w + 35), gate: false },
  { id: "E", label: "E = C + 会话闸门（开场/道别不强化）", ret: "new", bump: () => 100, gate: true },
];

const START_W = 15; // 所有记忆起点都是冷记忆（约 3 天前想起过）
function simulate(p) {
  const state = new Map(MEM.map((e) => [e.id, { w: START_W, last: 0 }]));
  let trueRecallHit = 0, trueRecallTotal = 0, falseHitRounds = 0, irrelevantRounds = 0;
  const log = [];
  for (const turn of T) {
    const { hits } = retrieve(turn.q, RETRIEVE[p.ret]);
    if (turn.intent.length) {
      trueRecallTotal++;
      if (hits.some((h) => turn.intent.includes(h.name))) trueRecallHit++;
    }
    const wrong = hits.filter((h) => !turn.intent.includes(h.name));
    if (wrong.length && !turn.intent.length) {
      falseHitRounds++;
      if (wrong.some((h) => h.group !== "ritual")) irrelevantRounds++;
    }
    const gated =
      (p.gate && (turn.role === "greeting" || turn.role === "farewell")) ||
      (p.onlyIntent && turn.intent.length === 0);
    for (const h of hits) {
      if (gated) continue;
      const s = state.get(h.id);
      s.w = p.bump(decay(s.w, turn.t - s.last));
      s.last = turn.t;
    }
    log.push({ ...turn, hits: hits.map((h) => h.name), gated });
  }
  // 逐小时采样
  const series = new Map();
  for (const e of MEM) {
    const s = state.get(e.id);
    const pts = [];
    for (let t = 0; t <= END; t++) {
      // 用「最后一次强化」之前的事件序列回放，避免重复结算：直接按每个强化点分段
      pts.push(0);
    }
    series.set(e.id, pts);
  }
  // 用事件序列精确回放每个记忆的权重曲线
  for (const e of MEM) {
    const evs = log.filter((x) => x.hits.includes(e.name) && !x.gated).map((x) => x.t);
    let w = START_W, last = 0, k = 0;
    const pts = series.get(e.id);
    for (let t = 0; t <= END; t++) {
      while (k < evs.length && evs[k] <= t) {
        w = p.bump(decay(w, evs[k] - last));
        last = evs[k]; k++;
      }
      pts[t] = decay(w, t - last);
    }
  }
  const stats = new Map();
  for (const e of MEM) {
    const pts = series.get(e.id);
    stats.set(e.id, {
      clearHours: pts.filter((w) => w >= 60).length,
      warmHours: pts.filter((w) => w >= 40).length,
      final: pts[END], peak: Math.max(...pts),
    });
  }
  return { stats, series, trueRecallHit, trueRecallTotal, falseHitRounds, irrelevantRounds, log };
}

const results = POLICIES.map((p) => ({ ...p, r: simulate(p) }));
// 理想基线：只在「真的在提这件事」的轮次复习，其余一律不强化。用作反事实参照。
const IDEAL = { id: "X", ret: "new", bump: () => 100, gate: false, onlyIntent: true };
const idealResult = simulate(IDEAL);

// ── 指标 ──
const NEVER_IDS = MEM.filter((e) => e.group === "never").map((e) => e.id);
const RITUAL_IDS = MEM.filter((e) => e.group === "ritual").map((e) => e.id);
const HOT_ID = 1;
function score(r) {
  const hot = r.stats.get(HOT_ID);
  const falseHours = NEVER_IDS.reduce((s, id) => s + r.stats.get(id).clearHours, 0);
  const ritualHours = RITUAL_IDS.reduce((s, id) => s + r.stats.get(id).clearHours, 0);
  const stoppedFinal = MEM.filter((e) => e.group === "stopped").map((e) => r.stats.get(e.id).final);
  const stoppedClear = MEM.filter((e) => e.group === "stopped")
    .reduce((s, e) => s + r.stats.get(e.id).clearHours, 0);
  return {
    keep: hot.clearHours >= 100 && hot.final >= 60,
    hotClear: hot.clearHours, hotFinal: hot.final,
    falseHours, ritualHours,
    fade: stoppedFinal.every((w) => w < 60), stoppedFinal, stoppedClear,
    recall: r.trueRecallTotal ? r.trueRecallHit / r.trueRecallTotal : 1,
    falseRounds: r.falseHitRounds, irrelevantRounds: r.irrelevantRounds,
  };
}
const ideal = score(idealResult);

// ── 终端摘要 ──
const R = Object.fromEntries(results.map((p) => [p.id, p.r]));
console.log("记忆强化时序评估 · 7 天 35 轮 · 13 条记忆 · 168 小时窗口");
console.log(`理想基线：停提组清晰 ${ideal.stoppedClear}h（其余为 0）\n`);
console.log("档位".padEnd(34), "常提保持", "清晰h", "末权重", "误提醒h", "仪式组h", "停提组h", "不相干误报轮");
for (const p of results) {
  const s = score(p.r);
  console.log(
    p.label.padEnd(34),
    (s.keep ? "✓ 通过" : "✗ 失败").padEnd(8),
    String(s.hotClear).padEnd(5),
    String(s.hotFinal).padEnd(6),
    String(s.falseHours).padEnd(7),
    String(s.ritualHours).padEnd(7),
    String(s.stoppedClear).padEnd(7),
    `${s.irrelevantRounds}  (真提召回 ${(s.recall * 100).toFixed(0)}%)`
  );
}
for (const id of ["A", "C"]) {
  console.log(`\n=== ${id} 档里被误命中过的记忆 ===`);
  for (const e of MEM) {
    const st = R[id].stats.get(e.id);
    const times = R[id].log.filter((x) => x.hits.includes(e.name) && !x.intent.includes(e.name)).length;
    if (times) console.log(`  ${e.name.padEnd(16)} 被误命中 ${times} 轮，清晰 ${st.clearHours}h，末权重 ${st.final}  [${e.group}]`);
  }
}

// ── HTML 报告 ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COLORS = { hot: "#c0392b", lowfreq: "#b8860b", stopped: "#4a6fa5", never: "#7a746c", ritual: "#8e44ad" };
function chart(p, ids) {
  const W = 560, H = 190, PX = 42, PY = 14, PW = W - PX - 14, PH = H - PY - 26;
  const x = (t) => PX + (t / END) * PW;
  const y = (w) => PY + PH - (w / 100) * PH;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#fff">`;
  for (const th of [40, 60]) svg += `<line x1="${PX}" y1="${y(th)}" x2="${W - 14}" y2="${y(th)}" stroke="#e6e1da" stroke-dasharray="4 4"/><text x="4" y="${y(th) + 4}" font-size="10" fill="#9a938a">${th}</text>`;
  for (let d = 0; d <= 7; d++) svg += `<line x1="${x(d * 24)}" y1="${PY}" x2="${x(d * 24)}" y2="${PY + PH}" stroke="#f1eee9"/><text x="${x(d * 24) - 4}" y="${H - 8}" font-size="10" fill="#9a938a">D${d}</text>`;
  for (const id of ids) {
    const e = MEM.find((m) => m.id === id), pts = p.r.series.get(id);
    const d = pts.map((w, t) => `${t === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(w).toFixed(1)}`).join(" ");
    svg += `<path d="${d}" fill="none" stroke="${COLORS[e.group]}" stroke-width="2" opacity=".9"/>`;
  }
  svg += `</svg>`;
  const legend = ids.map((id) => { const e = MEM.find((m) => m.id === id); return `<span style="color:${COLORS[e.group]}">● ${esc(e.name)}</span>`; }).join("　");
  return `<div class="chart"><div class="ct">${esc(p.label)}</div>${svg}<div class="lg">${legend}</div></div>`;
}

const rowScore = results.map((p) => { const s = score(p.r); return `<tr><td>${esc(p.label)}</td><td class="${s.keep ? "ok" : "err"}">${s.keep ? "✓ 保持" : "✗ 被遗忘"}</td><td>${s.hotClear}h</td><td>${s.hotFinal}</td><td class="${s.falseHours ? "err" : "ok"}">${s.falseHours}h</td><td>${s.ritualHours}h</td><td class="${s.stoppedClear > ideal.stoppedClear * 1.5 ? "err" : "ok"}">${s.stoppedClear}h</td><td class="${s.irrelevantRounds ? "err" : "ok"}">${s.irrelevantRounds}</td><td>${(s.recall * 100).toFixed(0)}%</td></tr>`; }).join("")
  + `<tr style="background:#f4f1ec"><td><b>X 理想基线（只在真提轮复习）</b></td><td class="ok">✓ 保持</td><td>${ideal.hotClear}h</td><td>${ideal.hotFinal}</td><td class="ok">${ideal.falseHours}h</td><td>${ideal.ritualHours}h</td><td><b>${ideal.stoppedClear}h</b></td><td class="ok">0</td><td>100%</td></tr>`;

const detailRows = MEM.map((e) => {
  const cells = results.map((p) => { const s = p.r.stats.get(e.id); return `<td>${s.clearHours}h / ${s.peak} / ${s.final}</td>`; }).join("");
  return `<tr><td><b>${esc(e.name)}</b></td><td><span style="color:${COLORS[e.group]}">${e.group}</span></td>${cells}</tr>`;
}).join("");

const aLog = R.A.log.filter((x) => x.hits.length && !x.intent.length).slice(0, 12).map((x) => `<tr><td>D${Math.floor(x.t / 24) + 1} ${x.t % 24}h</td><td>${esc(x.q)}</td><td class="err">${esc(x.hits.join("、"))}</td><td>${x.role}</td></tr>`).join("");
const cLog = R.C.log.filter((x) => x.hits.length && !x.intent.length).slice(0, 12).map((x) => `<tr><td>D${Math.floor(x.t / 24) + 1} ${x.t % 24}h</td><td>${esc(x.q)}</td><td>${esc(x.hits.join("、"))}</td><td>${x.role}</td></tr>`).join("");

const cA = score(R.A), cB = score(R.B), cB2 = score(R.B2), cC = score(R.C), cD = score(R.D), cE = score(R.E);
const e2Clear = R.A.stats.get(2).clearHours, e4Final = R.A.stats.get(4).final;
const conclusion = `<h2>结论</h2>
<div class="box" style="white-space:pre-wrap">1. <b>两个目标可以同时满足，但主力不是「改复习给多少」，而是「管住谁能触发复习」。</b>
C 档（新检索 + 保留你原本的「一次复习清零」）：常提的面馆清晰 ${cC.hotClear}h / 末权重 ${cC.hotFinal}，保持得住；从未被提过的记忆误提醒从 ${cA.falseHours}h 降到 ${cC.falseHours}h；不相干误报轮 ${cA.irrelevantRounds} → ${cC.irrelevantRounds}；真提召回仍 100%。

2. <b>现状（A）的危害不只是「这一轮冒三条」。</b>7 天里闲聊有 ${cA.irrelevantRounds} 轮撞上不相干记忆：两条从未被提过的事被顶到清晰档共 ${cA.falseHours}h；「妈妈做的番茄炒蛋」只真提过 2 次，却被误报顶得清晰 ${e2Clear}h；「周末去西山」被误报 4 轮，窗口末权重还有 ${e4Final}。停提组清晰 ${cA.stoppedClear}h，理想基线只有 ${ideal.stoppedClear}h —— 多出来的全是误报复习。这也是最初只看「末权重」会漏判的地方。

3. <b>「攒几次才到位」（我上一轮的推荐）被这份用例证伪，不该单独用。</b>
   - B（旧检索 + 累进 35）确实把长期误提醒压到 ${cB.falseHours}h，但本轮误报仍有 ${cB.irrelevantRounds} 轮，用户体感没改善；
   - B2 把增量调大到 +60，天天被撞的误报又攒回 ${cB2.falseHours}h，说明调参数挡不住重复误报；
   - D（新检索 + 累进 35）最糟：从冷记忆起步要爬 3 天，常提清晰小时 ${cC.hotClear}h → ${cD.hotClear}h、末权重掉到 ${cD.hotFinal}，<b>反而把常提的事拖模糊了</b>。
   保留「被真正想起一次就立刻清晰」+ 干净的准入门槛，比累进更贴合人类回想，也不需要新增参数。

4. <b>残留边界</b>：C 档里「晚安」「早上好」每天命中同名记忆，仪式组累计清晰 ${cC.ritualHours}h。若认定这也算误报，加会话时机闸门（E 档）可归零到 ${cE.ritualHours}h，常提保持不变；代价是要把会话状态（距上轮时长 / 是否首条末条）传进检索层，无法从内容判断。这是唯一需要外部信号的一档。

5. <b>口径说明</b>：早版「停提后淡忘」只看窗口末权重，会漏掉「被误报长期顶着、最后刚好掉下来」的情况，故补了停提组清晰小时与理想基线对照。</div>`;

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆强化时序评估 — jingjing</title><style>
:root{--bg:#faf9f7;--fg:#252321;--mut:#7a746c;--line:#e6e1da;--acc:#4a6fa5;--red:#c0392b;--green:#2e7d52;--amber:#b8860b}
*{box-sizing:border-box}body{margin:0;padding:32px 28px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1200px;margin:0 auto}h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.meta{color:var(--mut);font-size:13px;margin-bottom:22px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:12.5px;margin-bottom:10px}
th{background:#f4f1ec;text-align:left;padding:9px 10px;font-weight:600;color:#55504a;white-space:nowrap}td{padding:8px 10px;border-top:1px solid #f1eee9}tr:hover td{background:#fcfbf9}
.ok{color:var(--green);font-weight:600}.err{color:var(--red);font-weight:600}.warn{color:var(--amber);font-weight:600}
.box{background:#fff;border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:6px;padding:14px 18px;margin:14px 0;font-size:13px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px}
.chart{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.ct{font-size:12.5px;font-weight:600;margin-bottom:6px}.lg{font-size:11px;color:var(--mut);margin-top:4px}
code{background:#f1eee9;padding:1px 5px;border-radius:4px;font-size:12px}ul{margin:8px 0 0;padding-left:20px}li{margin:5px 0}
</style></head><body><div class="wrap">
<h1>记忆强化时序评估</h1>
<div class="meta">jingjing · 7 天 / 35 轮 / 13 条记忆 / 168 小时窗口 · 检索取自真实分词，衰减按 <code>decay.ts</code> 复刻</div>

<h2>用例设计</h2>
<div class="box">模拟一段真实陪伴：每天早中晚各打招呼、闲聊、道别，中间穿插真正提起往事。记忆按被提起的方式分五组：
<ul>
<li><b style="color:#c0392b">hot</b>「巷口面馆」每天提一次 —— 检验<b>常提的事能不能一直保持清晰</b></li>
<li><b style="color:#b8860b">lowfreq</b>「周末去西山」每 3 天提一次 —— 低频提起的边界</li>
<li><b style="color:#4a6fa5">stopped</b> 提过 1~2 次后就不再提 —— 应该自然淡忘，不该永生</li>
<li><b style="color:#7a746c">never</b> 从未被提起的 6 条 —— 一旦被误报强化并长期占位，就是「误报被长期提醒」</li>
<li><b style="color:#8e44ad">ritual</b>「早安问候」「睡前晚安」—— 每天打招呼/道别会命中，单列观察</li>
</ul>
每轮先跑检索，再按策略强化，最后按真实衰减曲线逐小时采样。<b>判定口径</b>：权重 ≥60 = 细节清晰、占记忆区前排；≥40 = 还在记忆区；&lt;40 = 冷记忆不再主动冒头。「误提醒小时」= 从未被真正提起的记忆处于 ≥60 的总小时数。</div>

<h2>五档策略对照</h2>
<table><thead><tr><th>策略</th><th>常提保持</th><th>常提清晰小时</th><th>常提末权重</th><th>误提醒小时</th><th>仪式组清晰小时</th><th>停提组清晰小时</th><th>不相干误报轮</th><th>真提召回</th></tr></thead><tbody>${rowScore}</tbody></table>
<div class="box"><b>怎么读这张表</b>：「常提保持」要求「巷口面馆」≥100 小时处于清晰档且窗口末仍 ≥60；「误提醒小时」= 从未被真提过的 6 条记忆处于 ≥60 的总小时数，越接近 0 越好；「停提组清晰小时」越接近最后那行理想基线越好，明显偏高说明本该淡忘的事被误报复习一直顶着。</div>

<h2>权重演化曲线</h2>
<div class="box">红 = 每天常提的面馆；灰 = 从未被提的记忆；紫 = 每天道晚安。虚线为 60（细节清晰）与 40（冷记忆线）。</div>
<div class="charts">${["A", "B2", "C", "E"].map((id) => chart(results.find((p) => p.id === id), [1, 7, 11])).join("")}</div>

<h2>逐条记忆明细（各档：清晰小时 / 峰值 / 末权重）</h2>
<table><thead><tr><th>记忆</th><th>组</th>${results.map((p) => `<th>${p.id}</th>`).join("")}</tr></thead><tbody>${detailRows}</tbody></table>

<h2>A 档：无意图轮次里被误命中的记忆（现状）</h2>
<table><thead><tr><th>时刻</th><th>用户输入</th><th>命中</th><th>轮次类型</th></tr></thead><tbody>${aLog || '<tr><td colspan="4">无</td></tr>'}</tbody></table>

<h2>C 档：同样轮次下的命中</h2>
<table><thead><tr><th>时刻</th><th>用户输入</th><th>命中</th><th>轮次类型</th></tr></thead><tbody>${cLog || '<tr><td colspan="4">无</td></tr>'}</tbody></table>

${conclusion}

<h2>评估边界</h2>
<div class="box"><ul>
<li>检索用真实 <code>tokenize.ts</code> + 停用词表 + 屏蔽词判定；SQL 粗召回用等价字符串包含模拟。衰减按 <code>decay.ts</code> 的 daily/priority 5 公式复刻（项目无 <code>node_modules</code>，别名模块无法直接 import）。</li>
<li>未纳入 episode 类型（按天衰减、下限 15）、权重优先级 1~9 差异、灵光一闪概率通道、Prompt 拼装细节。</li>
<li>「会话闸门」（E 档）用轮次角色模拟运行时信号（距上轮时长 / 是否首条末条），不是从内容判意图。真实接入需把会话状态传进检索层。</li>
<li>复跑：<code>node --experimental-strip-types tests/memory-weight.eval.mjs</code>，会重新生成本报告。</li>
</ul></div>
</div></body></html>`;
writeFileSync(OUT, html);
console.log(`\n报告已生成: ${OUT}`);
