// 记忆检索召回评估：node tests/retrieval.eval.mjs
//
// 人工标注集：tests/cases/retrieval.cases.mjs（改用例只改那里）
// 模拟记忆库：tests/cases/memories.mjs
// 分词、屏蔽词、命中门槛与打分排序取自真实源码并实际执行，SQL 粗召回用等价字符串包含模拟。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DOCS_DIR, assertKnownExpectations, loadRetrievalCore } from "./lib/harness.mjs";
import { ALL_FIELDS, SCORED_FIELDS, buildPool, createRetriever, TOP_N } from "./lib/retrieval-sim.mjs";
import { MEMORIES, RETRIEVABLE } from "./cases/memories.mjs";
import CASE_GROUPS from "./cases/retrieval.cases.mjs";

const OUT = path.join(DOCS_DIR, "retrieval-eval.html");
const real = await loadRetrievalCore();

/** 用例摊平成 { g: 分组, q: 输入, e: 理想命中, n: 考察点 } */
const C = CASE_GROUPS.flatMap(([g, cases]) => cases.map(([q, e, n]) => ({ g, q, e, n })));
assertKnownExpectations(
  C.map((c) => ({ q: c.q, expect: c.e })),
  MEMORIES.map((m) => m.name)
);

// 检索池：真实库里 active_weight 写入即 100，同分时按数组顺序（即事件创建先后）
const POOL = buildPool(RETRIEVABLE);

function evaluate(retriever, label) {
  let tp = 0, fp = 0, fn = 0, perfect = 0, sideEffects = 0;
  const rows = [];
  for (const c of C) {
    const { kw, hits: hitItems } = retriever.retrieve(c.q);
    const hits = hitItems.map((e) => e.name);
    if (hits.length > TOP_N) throw new Error(`用例「${c.q}」命中 ${hits.length} 条，超过上限 ${TOP_N}`);
    const exp = new Set(c.e);
    const hit = new Set(hits);
    const extra = hits.filter((n) => !exp.has(n));
    const missed = c.e.filter((n) => !hit.has(n));
    tp += hits.length - extra.length;
    fp += extra.length;
    fn += missed.length;
    if (extra.length === 0 && missed.length === 0) perfect++;
    const bad = c.e.length === 0 && hits.length > 0;
    if (bad) sideEffects++;
    rows.push({ ...c, kw, hits, extra, missed, ok: !bad && extra.length === 0 && missed.length === 0, bad });
  }
  return {
    label, rows,
    perfect, total: C.length,
    precision: tp + fp ? (tp / (tp + fp)) : 1,
    recall: tp + fn ? (tp / (tp + fn)) : 1,
    sideEffects, tp, fp, fn,
  };
}

const V = [
  // 上一版：全字段打分，标题命中就短路，长句要求 ≥2 个关键词 + 相对截断
  { label: "上一版 全字段 / 长≥2 / 截断", retriever: createRetriever(real, POOL, { fields: ALL_FIELDS, minFn: (kw) => (kw.length <= 2 ? kw.length : 2), ratio: 0.5, staged: true }) },
  // 当前实现：拆段 + IDF 加权 + 50% 截断，同分按最近被想起
  { label: "当前实现 拆段+IDF+截断 / 印象+标签", retriever: createRetriever(real, POOL, { fields: SCORED_FIELDS, idf: true, relCut: 0.5, clauses: true }) },
  // 参照：更早的实现（全字段、命中即算、标题命中就短路）
  { label: "更早 命中即算（全字段 / 两段式）", retriever: createRetriever(real, POOL, { fields: ALL_FIELDS, minFn: () => 1, staged: true }) },
  // 参照：只放宽门槛、不动字段，用来说明「字段」才是关键
  { label: "只放宽门槛 全字段 / 长≥1 / 两段式", retriever: createRetriever(real, POOL, { fields: ALL_FIELDS, minFn: (kw) => (kw.length <= 2 ? kw.length : 1), staged: true }) },
  // 实验：编辑距离兜底（独立成词 + 同位置一字 + 唯一候选）——已评估、决定不转正，留档备查
  { label: "实验 编辑距离兜底（未转正）", retriever: createRetriever(real, POOL, { fields: SCORED_FIELDS, idf: true, relCut: 0.5, clauses: true, fuzzy: true }) },
];
const results = V.map((v) => evaluate(v.retriever, v.label));
const before = results[0];
const after = results[1];

// ── 终端摘要 ──
const pct = (x) => (x * 100).toFixed(1) + "%";
console.log(`用例数: ${C.length}，记忆事件: ${RETRIEVABLE.length} 条（另 ${MEMORIES.length - RETRIEVABLE.length} 条未来事件/兜底不进检索池）\n`);
for (const r of results) {
  console.log(`[${r.label}] 完全正确 ${r.perfect}/${r.total} (${pct(r.perfect / r.total)})  Precision ${pct(r.precision)}  Recall ${pct(r.recall)}  寒暄/闲聊误触发副作用 ${r.sideEffects} 例`);
}
console.log("\n=== 当前实现（V1）仍判错的用例 ===");
for (const r of after.rows) {
  if (!r.ok) {
    console.log(`[${r.g}] 「${r.q}」 → 命中 [${r.hits.join(",") || "无"}]  期望 [${r.e.join(",") || "无"}]  ${r.extra.length ? "过召回:" + r.extra.join(",") : ""} ${r.missed.length ? "漏召回:" + r.missed.join(",") : ""} (关键词 ${r.kw.length})`);
  }
}
console.log("\n=== 分组（当前实现完全正确率）===");
const groups = [...new Set(C.map((c) => c.g))];
for (const g of groups) {
  const rs = after.rows.filter((r) => r.g === g);
  console.log(`${g}: ${rs.filter((r) => r.ok).length}/${rs.length}`);
}
console.log("\n=== 实验档与当前实现的逐条差异 ===");
for (const r of results.slice(4)) {
  const diff = r.rows.filter((x, i) => x.ok !== after.rows[i].ok);
  if (!diff.length) {
    console.log(`[${r.label}] 判定无翻转`);
    continue;
  }
  console.log(`[${r.label}] ${diff.length} 条判定翻转：`);
  for (const x of diff) {
  const base = after.rows.find((b) => b.q === x.q);
  console.log(`  ${base.ok ? "变坏" : "变好"} 「${x.q}」 当前[${base.hits.join(",") || "无"}] → 实验[${x.hits.join(",") || "无"}]  期望[${x.e.join(",") || "无"}]`);
  }
}

// ── HTML 报告 ──
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const card = (r) => `
  <div class="card">
    <div class="lab">${esc(r.label)}</div>
    <div class="big">${pct(r.perfect / r.total)}</div><div class="sub">逐例完全正确 ${r.perfect}/${r.total}</div>
    <div class="kv"><span>Precision</span><b>${pct(r.precision)}</b></div>
    <div class="kv"><span>Recall</span><b>${pct(r.recall)}</b></div>
    <div class="kv"><span>副作用误触发</span><b class="${r.sideEffects ? "bad" : "good"}">${r.sideEffects} 例</b></div>
    <div class="kv"><span>TP / FP / FN</span><b>${r.tp} / ${r.fp} / ${r.fn}</b></div>
  </div>`;

/** 分组正确率（前后对照用） */
const groupOk = (rows, g) => rows.filter((r) => r.g === g);
const groupRate = (rows, g) => {
  const rs = groupOk(rows, g);
  return { ok: rs.filter((r) => r.ok).length, total: rs.length, text: `${rs.filter((r) => r.ok).length}/${rs.length}` };
};

const groupRows = groups.map((g) => {
  const bs = groupRate(before.rows, g);
  const as = groupRate(after.rows, g);
  return `<tr><td>${esc(g)}</td><td>${bs.text}</td><td>${as.text}</td><td>${groupOk(after.rows, g).filter((r) => r.bad).length}</td></tr>`;
}).join("");

const detailRows = after.rows.map((r, i) => {
  const b = before.rows[i];
  const verdict = r.ok ? '<span class="ok">✓ 正确</span>'
    : r.bad ? '<span class="err">✗ 误命中</span>'
    : r.missed.length && r.extra.length ? '<span class="warn">△ 部分</span>'
    : r.missed.length ? '<span class="warn">△ 漏召回</span>'
    : '<span class="warn">△ 过召回</span>';
  return `<tr>
    <td class="grp">${esc(r.g)}</td>
    <td class="q">${esc(r.q)}</td>
    <td class="kw">${esc(r.kw.join(" / ") || "无")}</td>
    <td>${esc(r.e.join("、") || "—")}</td>
    <td class="old">${esc(b.hits.join("、") || "—")}</td>
    <td class="new">${esc(r.hits.join("、") || "—")}</td>
    <td>${verdict}</td>
    <td class="note">${esc(r.n)}</td>
  </tr>`;
}).join("");

// 结论里的分组数字从本次运行算出来，改用例后不会与表格打架
const changed = groups
  .map((g) => ({ g, b: groupRate(before.rows, g), a: groupRate(after.rows, g) }))
  .filter((x) => x.a.ok !== x.b.ok);
const worseText = changed.filter((x) => x.a.ok < x.b.ok).map((x) => `${x.g} ${x.b.text} → ${x.a.text}`).join("、") || "无";
const betterText = changed.filter((x) => x.a.ok > x.b.ok).map((x) => `${x.g} ${x.b.text} → ${x.a.text}`).join("、") || "无";
const dGroupBefore = groupRate(before.rows, "D 情绪");
const dGroupAfter = groupRate(after.rows, "D 情绪");

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆检索召回评估 — jingjing</title>
<style>
:root{--bg:#faf9f7;--fg:#252321;--mut:#7a746c;--line:#e6e1da;--acc:#4a6fa5;--red:#c0392b;--green:#2e7d52;--amber:#b8860b}
*{box-sizing:border-box}body{margin:0;padding:32px 28px;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1400px;margin:0 auto}h1{font-size:24px;margin:0 0 6px}h2{font-size:17px;margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.meta{color:var(--mut);font-size:13px;margin-bottom:24px}.cards{display:flex;gap:16px;flex-wrap:wrap}
.card{flex:1;min-width:250px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:18px 20px}
.lab{color:var(--mut);font-size:12px;letter-spacing:.04em}.big{font-size:34px;font-weight:700;margin:6px 0 0;color:var(--acc)}
.sub{color:var(--mut);font-size:12px;margin-bottom:14px}.kv{display:flex;justify-content:space-between;padding:5px 0;border-top:1px solid #f1eee9;font-size:13px}
.kv span{color:var(--mut)}.bad{color:var(--red)}.good{color:var(--green)}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:12.5px}
th{background:#f4f1ec;text-align:left;padding:9px 10px;font-weight:600;color:#55504a;white-space:nowrap}
td{padding:8px 10px;border-top:1px solid #f1eee9;vertical-align:top}tr:hover td{background:#fcfbf9}
.grp{color:var(--mut);white-space:nowrap}.q{font-weight:600;min-width:150px}.kw{color:var(--mut);font-size:11.5px;max-width:210px}
.old{color:#a0988c}.new{color:var(--fg);font-weight:600}.note{color:var(--mut);font-size:11.5px}
.ok{color:var(--green);font-weight:600}.err{color:var(--red);font-weight:600}.warn{color:var(--amber);font-weight:600}
.box{background:#fff;border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:6px;padding:14px 18px;margin:14px 0;font-size:13px}
.box b{color:var(--acc)}ul{margin:8px 0 0;padding-left:20px}li{margin:5px 0}code{background:#f1eee9;padding:1px 5px;border-radius:4px;font-size:12px}
#findings{white-space:pre-wrap}
</style></head><body><div class="wrap">
<h1>记忆检索召回评估</h1>
<div class="meta">jingjing · ${C.length} 条真实陪伴场景用例 · ${RETRIEVABLE.length} 条模拟往事 · 分词与打分函数取自真实源码 · 生成于 ${new Date().toLocaleString("zh-CN")}</div>

<h2>总体指标（上一版 / 当前实现）</h2>
<div class="cards">${card(before)}${card(after)}</div>
<div class="box"><b>指标口径</b>：逐例「完全正确」= 命中集合与理想集合完全一致；Precision = 正确命中 / 全部命中；Recall = 正确命中 / 全部应命中；「副作用误触发」= 本不该命中却命中（会写库刷权重、擦亮片段）。理想集合按「人听到这句话会想起什么」人工标注，见 <code>tests/cases/retrieval.cases.mjs</code>。</div>

<h2>实现对照</h2>
<table><thead><tr><th>实现</th><th>逐例完全正确</th><th>Precision</th><th>Recall</th><th>副作用误触发</th><th>TP / FP / FN</th></tr></thead><tbody>${results.map((r) => `<tr><td>${esc(r.label)}</td><td><b>${r.perfect}/${r.total}</b> (${pct(r.perfect / r.total)})</td><td>${pct(r.precision)}</td><td>${pct(r.recall)}</td><td class="${r.sideEffects ? "bad" : "good"}">${r.sideEffects} 例</td><td>${r.tp} / ${r.fp} / ${r.fn}</td></tr>`).join("")}</tbody></table>
<div class="box">三行是三代实现：<b>更早</b>（全字段、命中即算）→ <b>上一版</b>（全字段、长句要 ≥2 个词、相对截断、标题命中就停）→ <b>当前</b>（按标点拆段、两通道合并、IDF 加权 + 50% 截断、同分按最近被想起排，标签按写入侧新规范：情绪词进标签、时间词/泛称禁入）。第四行是参照组：只放宽门槛、不动字段，用来说明问题不在门槛。最后一行是 <b>编辑距离兜底实验</b>（未转正）：带四道闸（独立成词、同位置换一字、唯一候选、拼音差 ≤1 字）能零误报捞回「拉铁↔拿铁」，但只对「用户单独打出两字错字」这一个窄场景生效，且要引入拼音依赖——收益配不上复杂度，决定不进产品代码。</div>

<h2>分组表现</h2>
<table><thead><tr><th>场景组</th><th>上一版正确</th><th>当前实现正确</th><th>当前仍误命中</th></tr></thead><tbody>${groupRows}</tbody></table>

<h2>逐例明细</h2>
<table><thead><tr><th>组</th><th>用户输入</th><th>分词结果</th><th>理想命中</th><th>上一版命中</th><th>当前命中</th><th>判定</th><th>考察点</th></tr></thead><tbody>${detailRows}</tbody></table>

<h2>评估边界</h2>
<div class="box"><ul>
<li>分词（<code>tokenize.ts</code>）、屏蔽词（<code>isBlockedGram</code>）、IDF 加权与相对截断（<code>rankByOverlap</code>）均取自真实源码并实际执行；SQL 粗召回用等价的字符串包含模拟。</li>
<li>不含权重衰减、灵光一闪概率通道、Prompt 拼装；别名用事件自带的 alias 字段模拟（真实库是 memory_event_aliases 表），每条事件只有 1 条 gist + 1 条 summary，真实库片段更多，召回可能略高于本评估。</li>
<li>理想命中按「真实陪伴场景下什么算恰当」人工标注，情绪类用例带有语义期待，纯字符串检索天然难以满足——这正是评估要暴露的。</li>
<li>复跑：<code>node tests/retrieval.eval.mjs</code>，会重新生成本报告。</li>
</ul></div>

<h2>结论</h2>
<div class="box" id="findings">以下数值取自本次运行。

1. 从「不敢接」到「该接的接住」：逐例全对 ${before.perfect}/${before.total} → ${after.perfect}/${after.total}，Recall ${pct(before.recall)} → ${pct(after.recall)}；代价是精确率 ${pct(before.precision)} → ${pct(after.precision)}——多认回来的典型是「加班」顺带想起面馆（那件事本来就是加班后去吃面），算误伤，不算硬错。

2. 关键不在门槛，在「拿什么去比对」：只把门槛放宽到「长句命中 1 个词」（全字段、仍两段式）停在 ${results[3].perfect}/${results[3].total}、副作用 ${results[3].sideEffects} 例；把比对文本换成「一句话印象 + 写入时抽的标签」才到 ${after.perfect}/${after.total}、副作用 ${after.sideEffects} 例。summary 是完整叙述，「有点 / 觉得 / 一个人」这类虚词一撞就中。

3. 两条召回通道必须合并：上一版「标题命中就停」，于是「最近压力大，团子还生病了，都没好好吃饭」只想得起团子；合并后加班、团子、发烧三件都能想起来。分组变化——变差：${worseText}；变好：${betterText}。

4. 剩下 ${after.total - after.perfect} 条是机制与人的差距清单：否定句（「不是吃面，是火锅」「不是加班，是去唱K」）挡不住；硬干扰（「我妈公司楼下的面馆」撞上拉面/咖啡店）指的是别家；近邻挑不净（「妈妈的体检」也勾出自己的体检报告，gist/标题里的「周三」「朋友圈」「想去」这类字面照样撞）；纯情绪（「今天好累」）没有任何字面线索；Top3 注入上限——一次说四件事只给三条，跨段合并后第 4 件仍进不来；单字兜底只扫前 8 个字，句尾的「猫粮」够不着；英文同义词（overtime / coffee）没有对应标签，数字不参与分词（「38.5度」）；噪音 bigram（「跳槽的念头」里的「槽的」）会抬高相对截断线，把该召回的挤下去。

5. 情绪倾诉组 ${dGroupBefore.text} → ${dGroupAfter.text}：纯字符串检索无法从「累」联想到「加班」，属架构层面的差距，不是调参能补的。

6. 编辑距离兜底：评估后决定不转正。四道闸（独立成词、同位置换一字、唯一候选、拼音差 ≤1 字）确实能零误报捞回「拉铁↔拿铁」${results[4].perfect}/${results[4].total}，但四道闸缺一不可——去掉「独立成词」闸，时序剧情里「看到一只→到期」「越来越大了→大理」的噪音 bigram 立刻误报；去掉拼音闸，「拉铁」分不清拿铁和拉面。能安全生效的场景只剩「用户单独打出两字错字」这一种，收益配不上复杂度与拼音依赖，留档备查、等语义层（命中后模型复核）整体覆盖。</div>
</div></body></html>`;
mkdirSync(DOCS_DIR, { recursive: true });
writeFileSync(OUT, html);
console.log(`\n报告已生成: ${OUT}`);
