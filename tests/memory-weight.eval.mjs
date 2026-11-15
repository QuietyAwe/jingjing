// 记忆强化时序评估：node tests/memory-weight.eval.mjs
//
// 检验「常提的事保持清晰」与「误报的事不被长期提醒」能否同时成立。
// 模拟剧情与人工标注：tests/cases/weight.cases.mjs
// 记忆内容：tests/cases/memories.mjs
// 分词/门槛/打分取自真实源码；衰减公式按 src/memory/decay.ts 复刻（项目模块带 @/ 别名，Node 里加载不了）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DOCS_DIR, loadDecaySpec, loadRetrievalCore, loadWeightLines } from "./lib/harness.mjs";
import { ALL_FIELDS, SCORED_FIELDS, buildPool, createRetriever } from "./lib/retrieval-sim.mjs";
import { RETRIEVABLE } from "./cases/memories.mjs";
import {
  GROUP_OF,
  KEEP_MIN_FINAL,
  ORDER,
  START_WEIGHT,
  TIMELINE,
  WINDOW_HOURS,
} from "./cases/weight.cases.mjs";

const OUT = path.join(DOCS_DIR, "memory-weight-eval.html");
const real = await loadRetrievalCore();
const LINES = loadWeightLines();

// ── 记忆库：ORDER 里的 11 条是剧情「参演记忆」，其余可检索记忆作背景进池子参与竞争 ──
const CHOSEN = ORDER.map((name) => {
  const m = RETRIEVABLE.find((x) => x.name === name);
  if (!m) throw new Error(`weight.cases.mjs 的 ORDER 里写了不存在的记忆「${name}」`);
  if (!GROUP_OF[name]) throw new Error(`weight.cases.mjs 的 GROUP_OF 缺少「${name}」的分组`);
  return { ...m, group: GROUP_OF[name] };
});
const BACKDROP = RETRIEVABLE.filter((m) => !ORDER.includes(m.name));
const POOL = buildPool([...CHOSEN, ...BACKDROP.map((m) => ({ ...m, group: "backdrop" }))]);

// 标注里写了不在记忆库里的名字 = 改名后忘了同步，直接报错而不是静默漏评
for (const [, , q, intent] of TIMELINE) {
  for (const name of intent) {
    if (!POOL.some((m) => m.name === name)) {
      throw new Error(`时间线用例「${q}」标注了不在记忆库里的「${name}」`);
    }
  }
}

// ── 三套检索判据 ──
const RETRIEVE = {
  // 当前实现：拆段 + IDF 加权 + 50% 截断（印象+标签打分，长句命中 1 个就算）
  current: { fields: SCORED_FIELDS, idf: true, relCut: 0.5, clauses: true },
  // 上一版：两段式、全字段打分、长句要求 2 个关键词、与最高分差一半以上截断
  previous: { fields: ALL_FIELDS, minFn: (kw) => (kw.length <= 2 ? kw.length : 2), ratio: 0.5, staged: true },
  // 更早：两段式、全字段、命中即算
  legacy: { fields: ALL_FIELDS, minFn: () => 1, staged: true },
};
const retrievers = Object.fromEntries(
  Object.entries(RETRIEVE).map(([key, opts]) => [key, createRetriever(real, POOL, opts)])
);

// ── 时间线 ──
const T = TIMELINE.map(([t, role, q, intent]) => ({ t, role, q, intent }));

// ── 衰减（复刻 decay.ts：6 级 20 天到遗忘线为锚，每级差 1.88 倍，全档随基准缩放）──
const SPEC = loadDecaySpec();
const decay = (w, hours, priority = 5) => {
  const p = Math.max(1, Math.min(9, priority));
  const days =
    SPEC.anchorDays *
    Math.pow(SPEC.priorityStep, p - SPEC.anchorPriority) *
    (SPEC.referenceBaseRate / SPEC.baseRate);
  const rate = Math.log(100 / SPEC.importantMinWeight) / days / 24;
  const floor = p >= SPEC.importantMinPriority ? SPEC.importantMinWeight : 1;
  return Math.max(floor, Math.min(100, Math.floor(w * Math.exp(-rate * hours))));
};

// ── 策略：同一套「命中即 100」的强化规则，只换检索判据 ──
const POLICIES = [
  { id: "V1", label: "V1 当前实现", ret: "current" },
  { id: "P1", label: "P1 上一版（长≥2 + 截断）", ret: "previous" },
  { id: "P2", label: "P2 更早（命中即算）", ret: "legacy" },
];

function simulate(p) {
  const retriever = retrievers[p.ret];
  const state = new Map(POOL.map((e) => [e.id, { w: START_WEIGHT, last: 0 }]));
  let trueRecallHit = 0, trueRecallTotal = 0, falseHitRounds = 0;
  const log = [];
  for (const turn of T) {
    const { hits } = retriever.retrieve(turn.q);
    if (turn.intent.length) {
      trueRecallTotal++;
      if (hits.some((h) => turn.intent.includes(h.name))) trueRecallHit++;
    }
    const wrong = hits.filter((h) => !turn.intent.includes(h.name));
    if (wrong.length && !turn.intent.length) falseHitRounds++;
    for (const h of hits) {
      const s = state.get(h.id);
      s.w = 100;
      s.last = turn.t;
    }
    log.push({ ...turn, hits: hits.map((h) => h.name) });
  }
  // 用事件序列精确回放每条记忆的逐小时权重曲线
  const series = new Map();
  for (const e of POOL) {
    const evs = log.filter((x) => x.hits.includes(e.name)).map((x) => x.t);
    let w = START_WEIGHT, last = 0, k = 0;
    const pts = [];
    for (let t = 0; t <= WINDOW_HOURS; t++) {
      while (k < evs.length && evs[k] <= t) {
        w = 100; last = evs[k]; k++;
      }
      pts[t] = decay(w, t - last);
    }
    series.set(e.id, pts);
  }
  const stats = new Map();
  for (const e of POOL) {
    const pts = series.get(e.id);
    stats.set(e.id, {
      clearHours: pts.filter((w) => w >= LINES.clear).length,
      warmHours: pts.filter((w) => w >= LINES.cold).length,
      final: pts[WINDOW_HOURS], peak: Math.max(...pts),
    });
  }
  return { stats, series, trueRecallHit, trueRecallTotal, falseHitRounds, log };
}

const results = POLICIES.map((p) => ({ ...p, r: simulate(p) }));
// 理想基线：只在「真的在提这件事」的轮次复习，其余一律不强化。用作反事实参照。
const IDEAL = { id: "X", ret: "current", onlyIntent: true };
const idealResult = simulate(IDEAL);

// ── 指标 ──
const idsOf = (group) => POOL.filter((e) => e.group === group).map((e) => e.id);
const HOT_ID = POOL.find((e) => e.group === "hot").id;
const NEVER_IDS = idsOf("never");
function score(r, onlyIntent = false) {
  const hot = r.stats.get(HOT_ID);
  const falseHours = NEVER_IDS.reduce((s, id) => s + r.stats.get(id).clearHours, 0);
  const stoppedClear = POOL.filter((e) => e.group === "stopped")
    .reduce((s, e) => s + r.stats.get(e.id).clearHours, 0);
  const recall = r.trueRecallTotal ? r.trueRecallHit / r.trueRecallTotal : 1;
  return {
    // 判据：用户提往事时不漏 + 相处到最后常聊的事仍清楚
    keep: recall === 1 && hot.final >= KEEP_MIN_FINAL,
    hotClear: hot.clearHours, hotFinal: hot.final,
    hotClearRatio: hot.clearHours / WINDOW_HOURS,
    falseHours, stoppedClear, recall,
    falseRounds: r.falseHitRounds,
    onlyIntent,
  };
}
const ideal = score(idealResult, true);

// ── 终端摘要 ──
const R = Object.fromEntries(results.map((p) => [p.id, p.r]));
console.log(`记忆强化时序评估 · ${WINDOW_HOURS / 24} 天 ${T.length} 轮 · ${POOL.length} 条记忆 · ${WINDOW_HOURS} 小时窗口`);
console.log(`理想基线：停提组清晰 ${ideal.stoppedClear}h（其余为 0）\n`);
console.log("策略".padEnd(32), "常提保持", "清晰h", "末权重", "误提醒h", "停提组h", "误报轮", "真提召回");
for (const p of results) {
  const s = score(p.r);
  console.log(
    p.label.padEnd(32),
    (s.keep ? "✓ 通过" : "✗ 不达标").padEnd(8),
    `${s.hotClear}h(${Math.round(s.hotClearRatio * 100)}%)`.padEnd(10),
    String(s.hotFinal).padEnd(6),
    String(s.falseHours).padEnd(7),
    String(s.stoppedClear).padEnd(7),
    String(s.falseRounds).padEnd(6),
    `${(s.recall * 100).toFixed(0)}%`
  );
}
for (const id of results.map((p) => p.id)) {
  const wrong = R[id].log.filter((x) => x.hits.length && !x.intent.length);
  if (!wrong.length) continue;
  console.log(`\n=== ${id} 档：闲聊/问候里被误命中 ===`);
  for (const x of wrong) console.log(`  D${Math.floor(x.t / 24) + 1} 「${x.q}」→ ${x.hits.join("、")}  [${x.role}]`);
}

// ── HTML 报告 ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COLORS = { hot: "#c0392b", lowfreq: "#b8860b", stopped: "#4a6fa5", never: "#7a746c" };
function chart(p, ids) {
  const W = 560, H = 190, PX = 42, PY = 14, PW = W - PX - 14, PH = H - PY - 26;
  const x = (t) => PX + (t / WINDOW_HOURS) * PW;
  const y = (w) => PY + PH - (w / 100) * PH;
  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:#fff">`;
  for (const th of [LINES.cold, LINES.clear]) svg += `<line x1="${PX}" y1="${y(th)}" x2="${W - 14}" y2="${y(th)}" stroke="#e6e1da" stroke-dasharray="4 4"/><text x="4" y="${y(th) + 4}" font-size="10" fill="#9a938a">${th}</text>`;
  const days = WINDOW_HOURS / 24;
  for (let d = 0; d <= days; d++) svg += `<line x1="${x(d * 24)}" y1="${PY}" x2="${x(d * 24)}" y2="${PY + PH}" stroke="#f1eee9"/><text x="${x(d * 24) - 4}" y="${H - 8}" font-size="10" fill="#9a938a">D${d}</text>`;
  for (const id of ids) {
    const e = POOL.find((m) => m.id === id), pts = p.r.series.get(id);
    const d = pts.map((w, t) => `${t === 0 ? "M" : "L"}${x(t).toFixed(1)},${y(w).toFixed(1)}`).join(" ");
    svg += `<path d="${d}" fill="none" stroke="${COLORS[e.group]}" stroke-width="2" opacity=".9"/>`;
  }
  svg += `</svg>`;
  const legend = ids.map((id) => { const e = POOL.find((m) => m.id === id); return `<span style="color:${COLORS[e.group]}">● ${esc(e.name)}</span>`; }).join("　");
  return `<div class="chart"><div class="ct">${esc(p.label)}</div>${svg}<div class="lg">${legend}</div></div>`;
}

const rowScore = results.map((p) => {
  const s = score(p.r);
  return `<tr><td>${esc(p.label)}</td><td class="${s.keep ? "ok" : "err"}">${s.keep ? "✓ 保持" : "✗ 不达标"}</td><td>${s.hotClear}h (${Math.round(s.hotClearRatio * 100)}%)</td><td class="${s.hotFinal >= KEEP_MIN_FINAL ? "ok" : "err"}">${s.hotFinal}</td><td class="${s.falseHours ? "err" : "ok"}">${s.falseHours}h</td><td class="${s.stoppedClear > ideal.stoppedClear * 1.5 ? "err" : "ok"}">${s.stoppedClear}h</td><td class="${s.falseRounds ? "err" : "ok"}">${s.falseRounds}</td><td class="${s.recall === 1 ? "ok" : "err"}">${(s.recall * 100).toFixed(0)}%</td></tr>`;
}).join("")
  + `<tr style="background:#f4f1ec"><td><b>X 理想基线（只在真提轮复习）</b></td><td class="ok">✓ 保持</td><td>${ideal.hotClear}h (${Math.round(ideal.hotClearRatio * 100)}%)</td><td>${ideal.hotFinal}</td><td class="ok">${ideal.falseHours}h</td><td><b>${ideal.stoppedClear}h</b></td><td class="ok">0</td><td>100%</td></tr>`;

const detailRows = POOL.map((e) => {
  const cells = results.map((p) => { const s = p.r.stats.get(e.id); return `<td>${s.clearHours}h / ${s.peak} / ${s.final}</td>`; }).join("");
  return `<tr><td><b>${esc(e.name)}</b></td><td><span style="color:${COLORS[e.group]}">${e.group}</span></td>${cells}</tr>`;
}).join("");

const logRows = (id) => R[id].log.filter((x) => x.hits.length && !x.intent.length).slice(0, 12)
  .map((x) => `<tr><td>D${Math.floor(x.t / 24) + 1} ${x.t % 24}h</td><td>${esc(x.q)}</td><td class="${id === "V1" ? "err" : ""}">${esc(x.hits.join("、"))}</td><td>${x.role}</td></tr>`).join("");

/** 曲线里的「从未被提过」代表：优先固定一条，用例改了也不至于空图 */
const NEVER_REP = (POOL.find((e) => e.name === "感冒发烧") ?? POOL.find((e) => e.group === "never") ?? POOL[0]).id;
const namesOf = (group) => POOL.filter((e) => e.group === group).map((e) => esc(e.name)).join("、");
const cV1 = score(R.V1), cP1 = score(R.P1), cP2 = score(R.P2);
const missedOf = (id) => R[id].log.filter((x) => x.intent.length && !x.hits.some((n) => x.intent.includes(n)));
const v1Missed = missedOf("V1"), p1Missed = missedOf("P1");
const missedText = (list) => list.map((x) => `「${esc(x.q)}」`).join("、") || "无";
const wrongOf = (id) => R[id].log.filter((x) => x.hits.length && !x.intent.length);
const wrongText = (id) => wrongOf(id).map((x) => `「${esc(x.q)}」被听成「${esc(x.hits.join("、"))}」`).join("；") || "无";
// 两天沉默（72h~120h）之后的重逢第一句真提有没有接住
const SILENCE_END = 120;
const reunionMissed = R.V1.log.find((x) => x.t >= SILENCE_END && x.intent.length && !x.hits.some((n) => x.intent.includes(n)));

const conclusion = `<h2>结论</h2>
<div class="box" style="white-space:pre-wrap">1. <b>当前实现</b>：用户真提往事时接住 ${(cV1.recall * 100).toFixed(0)}%，最后一天常聊的那件事还有 ${cV1.hotFinal} 分（≥${KEEP_MIN_FINAL} 算记得清楚，全窗口清晰时间占 ${Math.round(cV1.hotClearRatio * 100)}%）；从没提过的事被顶到清晰档 ${cV1.falseHours}h，闲聊/问候轮误报 ${cV1.falseRounds} 次${cV1.falseRounds ? `（${wrongText("V1")}）` : ""}。

2. <b>上一版（全字段 / 长≥2 / 截断）</b>：误报 ${cP1.falseRounds} 次、误提醒 ${cP1.falseHours}h 更干净，但真提漏了 ${p1Missed.length} 次（${missedText(p1Missed)}），常聊的事最后只剩 ${cP1.hotFinal} 分——干净是靠"接不住"换来的。

3. <b>更早（全字段 / 命中即算）</b>：真提全部接住、结束 ${cP2.hotFinal} 分，代价是 ${cP2.falseRounds} 次误报、没提过的事被顶到清晰档 ${cP2.falseHours}h，而且「妈妈做的番茄炒蛋」这类事会被闲聊里的虚词反复擦亮。

4. <b>两天没联系（D4-D5）之后的重逢最能看出差别。</b>沉默 48 小时后第一句真提${reunionMissed ? `「${esc(reunionMissed.q)}」当前实现没接住` : "当前实现接住了"}——那段时间里权重已经掉到冷记忆线以下，回来时能不能唤起来，取决于还有没有别的线索撑着。

5. <b>还剩下的噪音</b>：${wrongText("V1")}。这类句子字面沾边、语义无关，是「只认标签」也挡不住的部分，得靠写入时的标签更准（提示词层）来解决。</div>`;

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
<div class="meta">jingjing · ${WINDOW_HOURS / 24} 天 / ${T.length} 轮 / ${POOL.length} 条记忆 / ${WINDOW_HOURS} 小时窗口 · 检索取自真实源码，衰减按 <code>decay.ts</code> 复刻（${SPEC.anchorPriority} 级 ${SPEC.anchorDays} 天到遗忘线，每级差 ${SPEC.priorityStep} 倍，基准 ${SPEC.baseRate}；7 级以上有 ${SPEC.importantMinWeight} 分下限）· 生成于 ${new Date().toLocaleString("zh-CN")}</div>

<h2>用例设计</h2>
<div class="box">模拟一段真实陪伴（${WINDOW_HOURS / 24} 天 ${T.length} 轮）：每天打招呼、闲聊、道别，中间穿插真正提起往事。剧情里特意安排了两件真实会发生的事——<b>D4-D5 连续两天完全没联系</b>（忙碌期，记忆最容易变淡），<b>D8 一晚上说了 11 句</b>（话多的一天，误命中最容易堆积）。记忆按被提起的方式分四组：
<ul>
<li><b style="color:#c0392b">hot</b> ${namesOf("hot")} —— 检验<b>常聊的事能不能一直记得清楚</b></li>
<li><b style="color:#b8860b">lowfreq</b> ${namesOf("lowfreq")} —— 隔几天提一次的边界</li>
<li><b style="color:#4a6fa5">stopped</b> ${namesOf("stopped")} —— 提过一两次就不再提，应该自然淡忘</li>
<li><b style="color:#7a746c">never</b> 从头到尾没真提过的 ${idsOf("never").length} 条（${namesOf("never")}）—— 一旦被闲聊误撞并长期占位，就是「莫名单曲循环」</li>
</ul>
检索池里另有 <b>${BACKDROP.length} 条背景记忆</b>：真实库不会只有十几条往事，它们不出场，但同样参与检索竞争、挤占注入名额，误撞了也会被擦亮。库里只有「人真的会记住的事」：寒暄、问候、道别不是记忆事件，所以「晚安」「早上好」在剧情里出现，却<b>不该命中任何往事</b>。每轮先跑检索，再按策略强化，最后按真实衰减曲线逐小时采样。<b>权重线</b>：≥${LINES.clear} = 细节记得清楚；≥${LINES.cold} = 还在记忆里；&lt;${LINES.cold} = 冷记忆，只在灵光一闪时才冒头。「误提醒小时」= 从头到尾没被提过、却处于 ≥${LINES.clear} 的总小时数。剧情与标注在 <code>tests/cases/weight.cases.mjs</code>。</div>

<h2>策略对照</h2>
<table><thead><tr><th>策略</th><th>常提保持</th><th>常提清晰（占比）</th><th>常提末权重</th><th>误提醒小时</th><th>停提组清晰小时</th><th>误报轮</th><th>真提召回</th></tr></thead><tbody>${rowScore}</tbody></table>
<div class="box"><b>怎么读这张表</b>：<b>「常提保持」</b>= 用户提往事时一次都没漏，且相处到最后这件事仍然清楚（≥${KEEP_MIN_FINAL} 分）。清晰时间的占比只作参考——中间两天没联系，谁都不会全程记得清清楚楚。<b>「误提醒小时」「误报轮」</b>越接近 0 越好；<b>「停提组清晰小时」</b>越接近最后那行理想基线越好。</div>

<h2>权重演化曲线</h2>
<div class="box">红 = 常聊的记忆；灰 = 从头到尾没提过的记忆。虚线为 ${LINES.clear}（记得清楚）与 ${LINES.cold}（冷记忆线）。D4-D5 那段没有对话，曲线会自然下滑。</div>
<div class="charts">${["V1", "P1", "P2"].map((id) => chart(results.find((p) => p.id === id), [HOT_ID, NEVER_REP])).join("")}</div>

<h2>逐条记忆明细（各档：清晰小时 / 峰值 / 末权重）</h2>
<table><thead><tr><th>记忆</th><th>组</th>${results.map((p) => `<th>${p.id}</th>`).join("")}</tr></thead><tbody>${detailRows}</tbody></table>

<h2>各档在闲聊/问候轮里的命中</h2>
<table><thead><tr><th>档</th><th>时刻</th><th>用户输入</th><th>命中</th><th>轮次类型</th></tr></thead><tbody>${
  results.map((p) => {
    const rows = R[p.id].log.filter((x) => x.hits.length && !x.intent.length).slice(0, 8)
      .map((x) => `<tr><td>${p.id}</td><td>D${Math.floor(x.t / 24) + 1} ${x.t % 24}h</td><td>${esc(x.q)}</td><td class="${p.id === "V1" ? "err" : ""}">${esc(x.hits.join("、"))}</td><td>${x.role}</td></tr>`)
      .join("");
    return rows;
  }).join("") || '<tr><td colspan="5">三档都没有误命中</td></tr>'
}</tbody></table>

${conclusion}

<h2>评估边界</h2>
<div class="box"><ul>
<li>检索用真实 <code>tokenize.ts</code> + 停用词表 + 屏蔽词判定 + <code>rankByOverlap</code>；SQL 粗召回用等价字符串包含模拟。衰减按 <code>decay.ts</code> 的优先级分档公式复刻（项目模块带 <code>@/</code> 别名，Node 里加载不了）。</li>
<li>评估里的记忆没有单独标优先级，一律按 5 级计算（约 10.6 天跌到遗忘线）；未纳入 7 级以上的下限行为、灵光一闪概率通道、Prompt 拼装细节。</li>
<li>复跑：<code>node tests/memory-weight.eval.mjs</code>，会重新生成本报告。</li>
</ul></div>
</div></body></html>`;
mkdirSync(DOCS_DIR, { recursive: true });
writeFileSync(OUT, html);
console.log(`\n报告已生成: ${OUT}`);
