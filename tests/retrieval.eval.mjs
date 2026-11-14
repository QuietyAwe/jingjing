// 记忆检索召回评估：node --experimental-strip-types tests/retrieval.eval.mjs
// 依赖真实 src/memory/tokenize.ts 与从 src/memory/retrieval.ts 提取的打分函数。
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "/workspace/jingjing";
const ART = "/root/.codebuddy/artifact/2f8a7d30-9c21-4f0b-1d6f-1faa455b2000";
const OUT = `${ROOT}/docs/retrieval-eval.html`;

const tokUrl = pathToFileURL(`${ROOT}/src/memory/tokenize.ts`).href;
const { tokenize, scoreOverlap } = await import(tokUrl);

// 真实源码：屏蔽词判定 + 命中门槛 + 打分排序
function extract(re, file, label) {
  const m = readFileSync(`${ROOT}/${file}`, "utf8").match(re);
  if (!m) throw new Error(`未找到 ${label}`);
  return m[0];
}
const parts = [
  extract(/function isBlockedGram\([\s\S]*?\n\}\n/, "src/memory/identity.ts", "isBlockedGram"),
  extract(/(?:export )?const HIT_SCORE_RATIO = [^\n]+/, "src/memory/retrieval.ts", "HIT_SCORE_RATIO"),
  extract(/function minHitScore\([\s\S]*?\n\}\n/, "src/memory/retrieval.ts", "minHitScore"),
  extract(/function rankByOverlap<[\s\S]*?\n\}\n/, "src/memory/retrieval.ts", "rankByOverlap"),
];
const tmp = `${ART}/eval-extract.ts`;
writeFileSync(
  tmp,
  `import { scoreOverlap } from "${tokUrl}";\n` +
    parts.join("\n\n") +
    `\nexport { isBlockedGram, minHitScore, rankByOverlap };\n`
);
const real = await import(pathToFileURL(tmp).href + `?v=${Date.now()}`);

const BLOCKED = ["阿柚", "私藏"]; // 用户昵称 + AI 名
const DEFAULT_EVENT = 15;

// ── 模拟记忆库：用户与「私藏」相处两个月积累的往事 ──
// fragments 对应真实库里该事件的多条片段（gist + summary + keywords），检索时拼接打分
const MEM = [
  { id: 1, name: "巷口面馆", event: "巷口面馆", alias: "", frags: [
    "[time]晚上[user]加完班去巷口面馆吃了一碗牛肉面",
    "[time]晚上[user]说加班结束绕去巷口面馆，点了牛肉面，汤头很暖，觉得一天的压力都被抚平了，还说下次要带[ai]一起去 巷口面馆 牛肉面 吃面 面馆 加班 夜宵",
  ] },
  { id: 2, name: "妈妈做的番茄炒蛋", event: "妈妈做的番茄炒蛋", alias: "", frags: [
    "[time][user]说想吃妈妈做的番茄炒蛋",
    "[time][user]聊起小时候妈妈做的番茄炒蛋，说外面怎么都做不出那个味道，有点想家 妈妈 母亲 我妈 老妈 番茄炒蛋 想家 老家",
  ] },
  { id: 3, name: "加班到很晚", event: "加班到很晚", alias: "", frags: [
    "[time][user]连着一周加班到很晚",
    "[time][user]说项目赶稿连着一周加班到凌晨，颈椎疼，语气很疲惫但没抱怨，只说想早点睡 加班 熬夜 项目 赶稿 疲惫 颈椎 压力",
  ] },
  { id: 4, name: "团子橘猫", event: "团子（橘猫）", alias: "", frags: [
    "[time][user]说团子又把桌上的杯子推下去了",
    "[time][user]家养了只橘猫叫团子，爱推桌上的东西，[user]嘴上嫌弃其实很宠 团子 橘猫 猫 宠物 推杯子",
  ] },
  { id: 5, name: "被领导批评", event: "被领导批评", alias: "", frags: [
    "[time][user]被领导当众批评了",
    "[time][user]说方案被领导当众否了，觉得委屈又不好意思跟同事说，回家跟[ai]讲了很久 领导 老板 批评 方案 委屈 当众 骂",
  ] },
  { id: 6, name: "周末去西山", event: "周末去西山", alias: "", frags: [
    "[time][user]周末去爬了西山",
    "[time][user]说周末一个人去爬西山，山顶风很大，拍了张照片，觉得好久没这么松快 西山 爬山 周末 山顶 照片",
  ] },
  { id: 7, name: "感冒发烧", event: "感冒发烧", alias: "", frags: [
    "[time][user]感冒发烧请假在家",
    "[time][user]说感冒发烧到38度，一个人躺了一天没人照顾，语气有点低落 感冒 发烧 生病 请假 38度",
  ] },
  { id: 8, name: "和小陈吵架", event: "和小陈吵架", alias: "", frags: [
    "[time][user]跟朋友小陈闹了别扭",
    "[time][user]说和小陈因为一件小事吵了架，其实不全是对方的问题，但拉不下脸先开口 小陈 朋友 吵架 闹别扭",
  ] },
  { id: 9, name: "手冲咖啡", event: "学做手冲咖啡", alias: "", frags: [
    "[time][user]开始学手冲咖啡",
    "[time][user]买了一套手冲器具，第一次冲出来的咖啡太酸，说要慢慢练 手冲 咖啡 拿铁 器具 太酸",
  ] },
  { id: 10, name: "童年外婆家", event: "童年外婆家", alias: "", frags: [
    "[time][user]聊起小时候在外婆家过暑假",
    "[time][user]说小时候暑假都在外婆家，院子里有棵枇杷树，那是记忆里最安稳的夏天 外婆 童年 暑假 枇杷树 院子",
  ] },
  { id: 11, name: "睡前晚安", event: "睡前晚安", alias: "", frags: [
    "[time][user]睡前跟[ai]说晚安",
    "[time][user]那阵子每晚睡前都会来跟[ai]说一声晚安，偶尔还会多聊两句才睡 晚安 睡前 道别 每晚",
  ] },
  { id: 12, name: "打算去大理", event: "打算去大理", alias: "", frags: [
    "[time][user]说想请年假去大理",
    "[time][user]说想请年假去大理住几天，看看洱海，还没订机票 大理 旅行 洱海 年假 机票",
  ] },
  { id: 13, name: "早安问候", event: "早安问候", alias: "", frags: [
    "[time][user]早上跟[ai]打招呼",
    "[time][user]有阵子每天早上会先发一句早上好再出门 早上好 早安 问候 出门",
  ] },
  { id: 14, name: "下周三面试", event: "下周三的面试", alias: "", frags: [
    "[time][user]说下周三有个面试",
    "面试 跳槽 offer 准备",
  ], status: "upcoming" },
  { id: 15, name: "日常闲聊", event: "日常闲聊", alias: "", frags: ["日常闲聊"], status: "default" },
];
for (const e of MEM) e.text = e.frags.join(" ");

// ── 用例集：真实陪伴场景，e = 理想命中，n = 考察点 ──
const C = [
  // A 寒暄 / 程式化应答
  { g: "A 寒暄", q: "晚上好", e: [], n: "问候（改动前误命中 3 条）" },
  { g: "A 寒暄", q: "早上好", e: [], n: "问候，库里恰有同名记忆" },
  { g: "A 寒暄", q: "早安", e: [], n: "问候" },
  { g: "A 寒暄", q: "晚安", e: [], n: "道别，库里恰有同名记忆" },
  { g: "A 寒暄", q: "在吗", e: [], n: "开场" },
  { g: "A 寒暄", q: "嗯嗯", e: [], n: "应答" },
  { g: "A 寒暄", q: "哈哈哈", e: [], n: "笑声" },
  { g: "A 寒暄", q: "谢谢啦", e: [], n: "致谢" },
  { g: "A 寒暄", q: "拜拜", e: [], n: "道别" },
  // B 短实词提起
  { g: "B 短实词", q: "吃面", e: ["巷口面馆"], n: "两字实词" },
  { g: "B 短实词", q: "加班", e: ["加班到很晚"], n: "两字实词" },
  { g: "B 短实词", q: "团子", e: ["团子橘猫"], n: "宠物名" },
  { g: "B 短实词", q: "咖啡", e: ["手冲咖啡"], n: "两字实词" },
  { g: "B 短实词", q: "猫", e: ["团子橘猫"], n: "单字（分词会丢弃）" },
  { g: "B 短实词", q: "大理", e: ["打算去大理"], n: "地名" },
  // C 换说法 / 同义提起
  { g: "C 换说法", q: "还记得那家吃面的地方吗", e: ["巷口面馆"], n: "不用原标题" },
  { g: "C 换说法", q: "我妈做的番茄炒蛋", e: ["妈妈做的番茄炒蛋"], n: "我妈" },
  { g: "C 换说法", q: "我母亲最近身体还好吗", e: ["妈妈做的番茄炒蛋"], n: "母亲" },
  { g: "C 换说法", q: "老妈的拿手菜", e: ["妈妈做的番茄炒蛋"], n: "老妈" },
  { g: "C 换说法", q: "老板又否了我的方案", e: ["被领导批评"], n: "老板/否了" },
  { g: "C 换说法", q: "上次那只小橘猫", e: ["团子橘猫"], n: "橘猫" },
  // D 情绪倾诉
  { g: "D 情绪", q: "今天好累啊", e: ["加班到很晚"], n: "纯情绪，无实词" },
  { g: "D 情绪", q: "被老板骂了，心里难受", e: ["被领导批评"], n: "情绪 + 事件线索" },
  { g: "D 情绪", q: "压力好大，睡不着", e: ["加班到很晚"], n: "情绪，无线索" },
  { g: "D 情绪", q: "有点想家", e: ["妈妈做的番茄炒蛋", "童年外婆家"], n: "情绪，多关联" },
  { g: "D 情绪", q: "心情低落", e: [], n: "无对应记忆" },
  // E 普通闲聊
  { g: "E 闲聊", q: "今天天气真好", e: [], n: "无记忆相关" },
  { g: "E 闲聊", q: "你在干嘛呢", e: [], n: "无记忆相关" },
  { g: "E 闲聊", q: "讲个笑话吧", e: [], n: "无记忆相关" },
  { g: "E 闲聊", q: "你觉得呢", e: [], n: "无记忆相关" },
  { g: "E 闲聊", q: "随便聊聊", e: [], n: "无记忆相关" },
  // F 身份名屏蔽
  { g: "F 身份名", q: "私藏你还记得我妈吗", e: ["妈妈做的番茄炒蛋"], n: "AI 名应被屏蔽" },
  { g: "F 身份名", q: "阿柚今天又加班了", e: ["加班到很晚"], n: "昵称应被屏蔽" },
  { g: "F 身份名", q: "私藏，晚安", e: [], n: "带名字的问候" },
  // G 多主题长句
  { g: "G 长句", q: "昨天加班到很晚，回来路上又去巷口面馆吃了碗面，还想起我妈做的番茄炒蛋", e: ["加班到很晚", "巷口面馆", "妈妈做的番茄炒蛋"], n: "三主题" },
  { g: "G 长句", q: "最近压力大，团子还生病了，都没好好吃饭", e: ["加班到很晚", "团子橘猫", "感冒发烧"], n: "三主题，表述模糊" },
  { g: "G 长句", q: "周末想去爬山，顺便把大理的机票订了", e: ["周末去西山", "打算去大理"], n: "双主题" },
  // H 时间词 / 未来事件
  { g: "H 时间", q: "昨天说的那个爬山", e: ["周末去西山"], n: "时间词被停用" },
  { g: "H 时间", q: "下周三的面试", e: [], n: "upcoming 由状态区负责，不进记忆检索" },
  { g: "H 时间", q: "上周感冒好点没", e: ["感冒发烧"], n: "时间词被停用" },
  // I 噪音 / 边界
  { g: "I 边界", q: "晚上好啊，今天好累", e: ["加班到很晚"], n: "寒暄 + 实质" },
  { g: "I 边界", q: "不是吃面，是火锅", e: [], n: "否定句" },
  { g: "I 边界", q: "😂😂", e: [], n: "纯表情" },
  { g: "I 边界", q: "嗯…那个…我想说", e: [], n: "纯语气词" },
];

// ── 检索管线（复刻 retrieval.ts 的两阶段粗召回 + 真实打分函数）──
function oldRank(candidates, pick, kw) {
  return candidates
    .map((item) => ({ item, score: scoreOverlap(pick(item), kw) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.item.active_weight - a.item.active_weight)
    .map((x) => x.item);
}

function retrieve(q, rank) {
  const kw = tokenize(q, 16, (g) => real.isBlockedGram(g, BLOCKED));
  const pool = MEM.filter((e) => e.id !== DEFAULT_EVENT && e.status !== "upcoming");
  if (kw.length === 0) return { kw, hits: [] };
  // 阶段 2：事件标题 / 别名
  let hits = rank(
    pool.filter((e) => kw.some((k) => `${e.event} ${e.alias}`.includes(k))),
    (e) => `${e.event} ${e.alias}`,
    kw
  ).slice(0, 3);
  // 阶段 3：事件未命中时检索片段
  if (hits.length === 0) {
    hits = rank(
      pool.filter((e) => kw.some((k) => e.text.includes(k))),
      (e) => e.text,
      kw
    ).slice(0, 3);
  }
  return { kw, hits: hits.map((e) => e.name) };
}

function evaluate(rank, label) {
  let tp = 0, fp = 0, fn = 0, perfect = 0, sideEffects = 0;
  const rows = [];
  for (const c of C) {
    const { kw, hits } = retrieve(c.q, rank);
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

function makeRank(minFn, ratio) {
  return (candidates, pick, kw) => {
    const min = minFn(kw);
    const ranked = candidates
      .map((item) => ({ item, score: scoreOverlap(pick(item), kw) }))
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score || b.item.active_weight - a.item.active_weight);
    const top = ranked[0]?.score ?? 0;
    return ranked.filter((x) => x.score >= top * ratio).map((x) => x.item);
  };
}

const V = [
  { label: "V0 改动前 score>0", rank: oldRank },
  { label: "V1 当前改动 minHitScore+截断", rank: real.rankByOverlap },
  { label: "V2 短输入严格 / 长输入 ≥1 + 截断", rank: makeRank((kw) => (kw.length <= 2 ? kw.length : 1), 0.5) },
  { label: "V3 短输入严格 / 长输入 ≥1 / 不截断", rank: makeRank((kw) => (kw.length <= 2 ? kw.length : 1), 1) },
];
const results = V.map((v) => evaluate(v.rank, v.label));
const before = results[0];
const after = results[1];

// ── 终端摘要 ──
const pct = (x) => (x * 100).toFixed(1) + "%";
console.log(`用例数: ${C.length}，记忆事件: ${MEM.length - 2} 条（另 1 默认 + 1 upcoming）\n`);
for (const r of results) {
  console.log(`[${r.label}] 完全正确 ${r.perfect}/${r.total} (${pct(r.perfect / r.total)})  Precision ${pct(r.precision)}  Recall ${pct(r.recall)}  寒暄/闲聊误触发副作用 ${r.sideEffects} 例`);
}
console.log("\n=== 改动后仍判错的用例 ===");
for (const r of after.rows) {
  if (!r.ok) {
    console.log(`[${r.g}] 「${r.q}」 → 命中 [${r.hits.join(",") || "无"}]  期望 [${r.e.join(",") || "无"}]  ${r.extra.length ? "过召回:" + r.extra.join(",") : ""} ${r.missed.length ? "漏召回:" + r.missed.join(",") : ""} (关键词 ${r.kw.length})`);
  }
}
console.log("\n=== 分组（改动后完全正确率）===");
const groups = [...new Set(C.map((c) => c.g))];
for (const g of groups) {
  const rs = after.rows.filter((r) => r.g === g);
  console.log(`${g}: ${rs.filter((r) => r.ok).length}/${rs.length}`);
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

const groupRows = groups.map((g) => {
  const rs = after.rows.filter((r) => r.g === g);
  const bs = before.rows.filter((r) => r.g === g);
  return `<tr><td>${esc(g)}</td><td>${bs.filter((r) => r.ok).length}/${bs.length}</td><td>${rs.filter((r) => r.ok).length}/${rs.length}</td><td>${rs.filter((r) => r.bad).length}</td></tr>`;
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
<div class="meta">jingjing · dev 6a40fff · ${C.length} 条真实陪伴场景用例 · ${MEM.length - 2} 条模拟往事 · 分词与打分函数取自真实源码</div>

<h2>总体指标（改动前 / 改动后）</h2>
<div class="cards">${card(before)}${card(after)}</div>
<div class="box"><b>指标口径</b>：逐例「完全正确」= 命中集合与理想集合完全一致；Precision = 正确命中 / 全部命中；Recall = 正确命中 / 全部应命中；「副作用误触发」= 本不该命中却命中（会写库刷权重、补氛围记忆、擦亮片段）。理想集合按真实陪伴语义人工标注。</div>

<h2>修正方案对照</h2>
<table><thead><tr><th>方案</th><th>逐例完全正确</th><th>Precision</th><th>Recall</th><th>副作用误触发</th><th>TP / FP / FN</th></tr></thead><tbody>${results.map((r) => `<tr><td>${esc(r.label)}</td><td><b>${r.perfect}/${r.total}</b> (${pct(r.perfect / r.total)})</td><td>${pct(r.precision)}</td><td>${pct(r.recall)}</td><td class="${r.sideEffects ? "bad" : "good"}">${r.sideEffects} 例</td><td>${r.tp} / ${r.fp} / ${r.fn}</td></tr>`).join("")}</tbody></table>
<div class="box">V2/V3 为验证根因的候选修正：仅对短输入（关键词 ≤2）要求全部命中，长输入放宽回 ≥1，其余不变。</div>

<h2>分组表现</h2>
<table><thead><tr><th>场景组</th><th>改动前正确</th><th>改动后正确</th><th>改动后仍误命中</th></tr></thead><tbody>${groupRows}</tbody></table>

<h2>逐例明细</h2>
<table><thead><tr><th>组</th><th>用户输入</th><th>分词结果</th><th>理想命中</th><th>改动前命中</th><th>改动后命中</th><th>判定</th><th>考察点</th></tr></thead><tbody>${detailRows}</tbody></table>

<h2>评估边界</h2>
<div class="box"><ul>
<li>分词（<code>tokenize.ts</code>）、屏蔽词（<code>isBlockedGram</code>）、门槛与打分（<code>minHitScore</code> / <code>rankByOverlap</code>）均取自真实源码并实际执行；SQL 粗召回用等价的字符串包含模拟。</li>
<li>不含权重衰减、灵光一闪概率通道、Prompt 拼装；未模拟别名表与真实多片段库（每条事件用 2 条片段拼接），真实库的片段更多，召回可能略高于本评估。</li>
<li>理想命中按「真实陪伴场景下什么算恰当」人工标注，情绪类用例带有语义期待，纯字符串检索天然难以满足——这正是评估要暴露的。</li>
<li>复跑：<code>node --experimental-strip-types tests/retrieval.eval.mjs</code>，会重新生成本报告。</li>
</ul></div>

<h2>结论</h2>
<div class="box" id="findings">1. 当前改动（V1）是净负收益。Precision 64.9% → 75.0%，但 Recall 80.0% → 40.0%，逐例完全正确 68.2% → 54.5%。副作用误触发 8 → 4 例确有改善，代价是 44 条里多错 6 条。

2. 回归集中在最核心的场景：换说法 6/6 → 2/6、时间词 3/3 → 1/3、身份名 2/3 → 0/3、多主题长句 2/3 → 1/3；改善只落在寒暄 5/9 → 6/9、闲聊 4/5 → 5/5、边界 2/4 → 3/4。也就是「不翻旧账」变好了，「想起往事」明显变差——后者才是陪伴 App 的主功能。

3. 根因：minHitScore 把门槛绑在「输入关键词总数」上。bigram 枚举让长句必然带一堆噪音 bigram，而一条真正相关的记忆往往只共享 1 个实词；长输入被要求 ≥2 分，「我母亲最近身体还好吗」「阿柚今天又加班了」「上周感冒好点没」全被挡掉。相对截断又进一步丢掉多主题长句里的次相关事件。

4. 单纯放宽回不去：V2/V3 把 Recall 恢复到 76.7%、完全正确回到 68.2%，但副作用误触发回升到 7 例。「早上好 / 早安 / 晚安」是真实词且库里有同名记忆，属于触发时机问题，与打分门槛无关。

5. 建议换判据，而不是继续调数值：① 命中只认关键字段（event_text / alias / keywords），summary / gist 的模板话不算实质命中——等于复用写入时 LLM 已做过的语义判断；② 单词问候交给会话开场信号；③ 单字「猫」被分词层丢弃，单独处理。三者都不需要词表。

6. 固有短板：情绪倾诉 D 组改动前后都是 1/5，纯字符串检索无法从「今天好累」联想到「加班到很晚」，属架构限制，不是本次改动引入。</div>
</div></body></html>`;
writeFileSync(OUT, html);
console.log(`\n报告已生成: ${OUT}`);
