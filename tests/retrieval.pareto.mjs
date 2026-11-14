// 检索方案对照：验证零词表的正交判据能否在不降召回的前提下减少误命中。
// 复跑：node --experimental-strip-types tests/retrieval.pareto.mjs
// 分词、停用词表、屏蔽词判定取自真实源码；用例集复用 tests/retrieval.eval.mjs。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = "/workspace/jingjing";
const { tokenize, scoreOverlap } = await import(pathToFileURL(`${ROOT}/src/memory/tokenize.ts`).href);

// 真实停用词表（从源码取，不新增词表）
const tsrc = readFileSync(`${ROOT}/src/memory/tokenize.ts`, "utf8");
const STOP = new Set(new Function("return [" + tsrc.match(/const STOP_WORDS = new Set\(\[([\s\S]*?)\]\);/)[1] + "]")());
// isBlockedGram 的等价 JS 复刻（identity.ts:48-54）
const isBlockedGram = (g, words) => words.some((w) => w.includes(g) || g.includes(w));
const BLOCKED = ["阿柚", "私藏"];

// 复用 44 条用例
const esrc = readFileSync(`${ROOT}/tests/retrieval.eval.mjs`, "utf8");
const C = new Function("return " + esrc.match(/const C = (\[[\s\S]*?\n\]);/)[1])();

// 字段化记忆库：模拟真实 schema 的 event_text / alias / gist / summary / keywords
const MEM = [
  { id: 1, name: "巷口面馆", event: "巷口面馆", alias: "", gist: "[time]晚上[user]加完班去巷口面馆吃了一碗牛肉面", summary: "[time]晚上[user]说加班结束绕去巷口面馆，点了牛肉面，汤头很暖，觉得一天的压力都被抚平了，还说下次要带[ai]一起去", kw: "巷口面馆 牛肉面 吃面 面馆 加班 夜宵" },
  { id: 2, name: "妈妈做的番茄炒蛋", event: "妈妈做的番茄炒蛋", alias: "", gist: "[time][user]说想吃妈妈做的番茄炒蛋", summary: "[time][user]聊起小时候妈妈做的番茄炒蛋，说外面怎么都做不出那个味道，有点想家", kw: "妈妈 母亲 我妈 老妈 番茄炒蛋 想家 老家" },
  { id: 3, name: "加班到很晚", event: "加班到很晚", alias: "", gist: "[time][user]连着一周加班到很晚", summary: "[time][user]说项目赶稿连着一周加班到凌晨，颈椎疼，语气很疲惫但没抱怨，只说想早点睡", kw: "加班 熬夜 项目 赶稿 疲惫 颈椎 压力" },
  { id: 4, name: "团子橘猫", event: "团子（橘猫）", alias: "", gist: "[time][user]说团子又把桌上的杯子推下去了", summary: "[time][user]家养了只橘猫叫团子，爱推桌上的东西，[user]嘴上嫌弃其实很宠", kw: "团子 橘猫 猫 宠物 推杯子" },
  { id: 5, name: "被领导批评", event: "被领导批评", alias: "", gist: "[time][user]被领导当众批评了", summary: "[time][user]说方案被领导当众否了，觉得委屈又不好意思跟同事说，回家跟[ai]讲了很久", kw: "领导 老板 批评 方案 委屈 当众 骂" },
  { id: 6, name: "周末去西山", event: "周末去西山", alias: "", gist: "[time][user]周末去爬了西山", summary: "[time][user]说周末一个人去爬西山，山顶风很大，拍了张照片，觉得好久没这么松快", kw: "西山 爬山 周末 山顶 照片" },
  { id: 7, name: "感冒发烧", event: "感冒发烧", alias: "", gist: "[time][user]感冒发烧请假在家", summary: "[time][user]说感冒发烧到38度，一个人躺了一天没人照顾，语气有点低落", kw: "感冒 发烧 生病 请假 38度" },
  { id: 8, name: "和小陈吵架", event: "和小陈吵架", alias: "", gist: "[time][user]跟朋友小陈闹了别扭", summary: "[time][user]说和小陈因为一件小事吵了架，其实不全是对方的问题，但拉不下脸先开口", kw: "小陈 朋友 吵架 闹别扭" },
  { id: 9, name: "手冲咖啡", event: "学做手冲咖啡", alias: "", gist: "[time][user]开始学手冲咖啡", summary: "[time][user]买了一套手冲器具，第一次冲出来的咖啡太酸，说要慢慢练", kw: "手冲 咖啡 拿铁 器具 太酸" },
  { id: 10, name: "童年外婆家", event: "童年外婆家", alias: "", gist: "[time][user]聊起小时候在外婆家过暑假", summary: "[time][user]说小时候暑假都在外婆家，院子里有棵枇杷树，那是记忆里最安稳的夏天", kw: "外婆 童年 暑假 枇杷树 院子" },
  { id: 11, name: "睡前晚安", event: "睡前晚安", alias: "", gist: "[time][user]睡前跟[ai]说晚安", summary: "[time][user]那阵子每晚睡前都会来跟[ai]说一声晚安，偶尔还会多聊两句才睡", kw: "晚安 睡前 道别 每晚" },
  { id: 12, name: "打算去大理", event: "打算去大理", alias: "", gist: "[time][user]说想请年假去大理", summary: "[time][user]说想请年假去大理住几天，看看洱海，还没订机票", kw: "大理 旅行 洱海 年假 机票" },
  { id: 13, name: "早安问候", event: "早安问候", alias: "", gist: "[time][user]早上跟[ai]打招呼", summary: "[time][user]有阵子每天早上会先发一句早上好再出门", kw: "早上好 早安 问候 出门" },
  { id: 14, name: "下周三面试", event: "下周三的面试", alias: "", gist: "", summary: "", kw: "面试 跳槽 offer 准备", upcoming: true },
  { id: 15, name: "日常闲聊", event: "日常闲聊", alias: "", gist: "日常闲聊", summary: "", kw: "", def: true },
];
const POOL = MEM.filter((e) => !e.def && !e.upcoming);

// 停用词先按字符串剥离，再切 bigram（复用现有词表，只改处理顺序）
const STOP_MULTI = [...STOP].filter((w) => w.length >= 2 && /^[一-鿿]+$/.test(w)).sort((a, b) => b.length - a.length);
const stripStop = (text) => STOP_MULTI.reduce((t, w) => t.split(w).join(""), text);

const ALL = ["gist", "summary", "kw"];
const KEY = ["kw"];
const GIST_KW = ["gist", "kw"];

function retrieve(q, o, pool = POOL) {
  const kw = tokenize(o.strip ? stripStop(q) : q, 16, (g) => isBlockedGram(g, BLOCKED));
  if (kw.length === 0) return { kw, hits: [] };
  const has = (s) => kw.some((k) => s.includes(k));
  // keywords 为空时回退到 gist（真实库里 LLM 抽取质量不齐）
  const pick = (e, fields) => fields.map((f) => e[f] ?? "").join(" ") || (e.kw ? "" : e.gist);
  const rank = (cands, textOf) => {
    const min = o.minFn(kw);
    const ranked = cands
      .map((item) => ({ item, s: scoreOverlap(textOf(item), kw) }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s || a.item.id - b.item.id);
    if (!ranked.length) return [];
    const top = ranked[0].s;
    return (o.ratio ? ranked.filter((x) => x.s >= top * o.ratio) : ranked).map((x) => x.item);
  };
  let hits = rank(
    pool.filter((e) => has(`${e.event} ${e.alias}`)),
    (e) => `${e.event} ${e.alias}`
  ).slice(0, 3);
  if (hits.length === 0) {
    hits = rank(
      pool.filter((e) => has(pick(e, o.fields))),
      (e) => pick(e, o.fields)
    ).slice(0, 3);
  }
  return { kw, hits: hits.map((e) => e.name) };
}

function evaluate(o) {
  let tp = 0, fp = 0, fn = 0, perfect = 0, badHit = 0, badPersist = 0;
  const badRows = [], missRows = [];
  const pool = o.dropKw ? POOL.map((e) => ({ ...e, kw: e.id % 3 === 0 ? "" : e.kw })) : POOL;
  for (const c of C) {
    const { kw, hits } = retrieve(c.q, o, pool);
    const exp = new Set(c.e), hit = new Set(hits);
    const extra = hits.filter((n) => !exp.has(n));
    const missed = c.e.filter((n) => !hit.has(n));
    tp += hits.length - extra.length; fp += extra.length; fn += missed.length;
    if (!extra.length && !missed.length) perfect++;
    const bad = c.e.length === 0 && hits.length > 0;
    if (bad) {
      badHit++;
      // 单词/单线索命中降级：不写库刷权重、不补氛围、不擦亮片段
      const light = o.lightSingle && kw.length === 1;
      if (!light) badPersist++;
      badRows.push(`「${c.q}」→ ${hits.join(",")}${light ? " [轻量:不写库]" : ""}`);
    }
    if (missed.length) missRows.push(`「${c.q}」漏 ${missed.join(",")}`);
  }
  return {
    perfect, total: C.length,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    badHit, badPersist, badRows, missRows, tp, fp, fn,
  };
}

const minV1 = (kw) => (kw.length <= 2 ? kw.length : 2);
const minAdaptive = (kw) => (kw.length <= 2 ? kw.length : 1);
const V = [
  { id: "V0", desc: "改动前：全字段 / score>0", fields: ALL, minFn: () => 1, ratio: 0 },
  { id: "V1", desc: "当前：全字段 / 短全·长≥2 / 截断", fields: ALL, minFn: minV1, ratio: 0.5 },
  { id: "N1", desc: "关键字段 / 短全·长≥1", fields: KEY, minFn: minAdaptive, ratio: 0 },
  { id: "N2", desc: "N1 + 相对截断 0.5", fields: KEY, minFn: minAdaptive, ratio: 0.5 },
  { id: "N3", desc: "N1 + 停用词先剥离", fields: KEY, minFn: minAdaptive, ratio: 0, strip: true },
  { id: "N4", desc: "N3 + 相对截断 0.5", fields: KEY, minFn: minAdaptive, ratio: 0.5, strip: true },
  { id: "N5", desc: "gist+kw / 短全·长≥1 / 剥离", fields: GIST_KW, minFn: minAdaptive, ratio: 0, strip: true },
  { id: "N6", desc: "N1 + 单词命中降级副作用", fields: KEY, minFn: minAdaptive, ratio: 0, lightSingle: true },
  { id: "N7", desc: "N3 + 单词降级（推荐组合）", fields: KEY, minFn: minAdaptive, ratio: 0, strip: true, lightSingle: true },
  { id: "N8", desc: "N7 + 1/3 事件 keywords 为空（回退 gist）", fields: KEY, minFn: minAdaptive, ratio: 0, strip: true, lightSingle: true, dropKw: true },
];

const pct = (x) => (x * 100).toFixed(1) + "%";
console.log("方案".padEnd(34), "完全正确".padEnd(12), "Precision".padEnd(10), "Recall".padEnd(9), "误命中", "误命中且写库");
for (const v of V) {
  const r = evaluate(v);
  console.log(
    `${v.id} ${v.desc}`.padEnd(34),
    `${r.perfect}/${r.total} (${pct(r.perfect / r.total)})`.padEnd(12),
    pct(r.precision).padEnd(10),
    pct(r.recall).padEnd(9),
    String(r.badHit).padEnd(6),
    String(r.badPersist)
  );
  v._r = r;
}
console.log("\n=== N7（推荐组合）残留判错 ===");
const best = V.find((v) => v.id === "N7")._r;
console.log("误命中：\n" + (best.badRows.join("\n") || "无"));
console.log("漏召回：\n" + best.missRows.join("\n"));
