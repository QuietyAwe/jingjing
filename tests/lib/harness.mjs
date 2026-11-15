// 评估脚本的公共环境：定位仓库、读取真实源码、校验人工标注集。
//
// 评估脚本不引入项目自身的模块图（@/ 别名 + AsyncStorage 在 Node 里加载不了），
// 所以这里用两种方式取真实实现：
// - tokenize.ts 无依赖，直接 import；
// - retrieval.ts / identity.ts 里的私有函数，用正则截取函数源码拼成临时 .ts 再 import。
// 截取失败会立刻抛错（源码结构调整时就该同步这里），不会静默跑过期逻辑。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 仓库根目录（本文件位于 tests/lib/ 下） */
export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
/** 报告输出目录 */
export const DOCS_DIR = path.join(ROOT, "docs");

/** 读取源码并统一成 LF：Windows 检出是 CRLF，按 \n 写的截取正则会全部失配 */
export function readSource(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n?/g, "\n");
}

/**
 * 从源码里截一段文本（函数定义 / 常量）
 * @param relPath 相对仓库根的文件路径
 * @param pattern 匹配整段的正则
 * @param label 报错时显示的名字
 */
export function extractFrom(relPath, pattern, label) {
  const m = readSource(relPath).match(pattern);
  if (!m) {
    throw new Error(`无法从 ${relPath} 抽取 ${label}：源码结构已变，请同步 tests/lib/harness.mjs`);
  }
  return m[0];
}

/** 真实停用词表：解析 tokenize.ts 里的 Set 字面量，不用 eval */
export function loadStopWords() {
  const m = readSource("src/memory/tokenize.ts").match(/const STOP_WORDS = new Set\(\[([\s\S]*?)\]\);/);
  if (!m) throw new Error("无法从 src/memory/tokenize.ts 解析 STOP_WORDS：定义格式已变");
  const body = m[1]
    .replace(/\/\/[^\n]*/g, "")
    .replace(/,\s*$/, "");
  return new Set(JSON.parse(`[${body}]`));
}

/** 真实分词与打分 */
export async function loadTokenizer() {
  const url = pathToFileURL(path.join(ROOT, "src/memory/tokenize.ts")).href;
  const mod = await import(url);
  return {
    tokenize: mod.tokenize,
    scoreOverlap: mod.scoreOverlap,
    singleCharKeywords: mod.singleCharKeywords,
    stopWords: loadStopWords(),
  };
}

/** 真实检索内核：分词 + 屏蔽词 + 命中门槛（打分与排序在 retrieval-sim 里镜像产品逻辑） */
export async function loadRetrievalCore() {
  const tokenizeUrl = pathToFileURL(path.join(ROOT, "src/memory/tokenize.ts")).href;
  const parts = [
    extractFrom("src/memory/identity.ts", /function isBlockedGram\([\s\S]*?\n\}/, "isBlockedGram"),
  ];
  const dir = path.join(tmpdir(), "jingjing-eval");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `retrieval-core-${process.pid}.ts`);
  writeFileSync(
    file,
    [
      `import { scoreOverlap } from "${tokenizeUrl}";`,
      ...parts,
      `export { isBlockedGram };`,
    ].join("\n\n")
  );
  const core = await import(pathToFileURL(file).href + `?v=${Date.now()}`);
  return { ...(await loadTokenizer()), ...core };
}

/** 权重分层线：清晰（细节可见）与冷记忆，取自 decay.ts，避免评估里另写一套数字 */
export function loadWeightLines() {
  const src = readSource("src/memory/decay.ts");
  const read = (name) => {
    const m = src.match(new RegExp(`export const ${name} = (\\d+);`));
    if (!m) throw new Error(`无法从 src/memory/decay.ts 解析 ${name}`);
    return Number(m[1]);
  };
  return { clear: read("DETAIL_VISIBLE_WEIGHT"), cold: read("COLD_MEMORY_MAX_WEIGHT") };
}

/** 日常记忆衰减基准（读默认配置，改配置时评估跟着变） */
export function loadDecayBaseRate() {
  const cfg = JSON.parse(readSource("src/prompt/defaultConfig.json"));
  const base = cfg.weight_decay?.ebbinghaus_decay_rate;
  if (typeof base !== "number") throw new Error("defaultConfig.json 缺少 weight_decay.ebbinghaus_decay_rate");
  return base;
}

/**
 * 校验人工标注集：标注里写了库里不存在的记忆名，多半是改名后忘了同步，直接报错而不是静默漏召回
 * @param cases [{ q, expect }]
 * @param knownNames 记忆库里全部可命中的名字
 */
export function assertKnownExpectations(cases, knownNames) {
  const known = new Set(knownNames);
  for (const c of cases) {
    for (const name of c.expect) {
      if (!known.has(name)) {
        throw new Error(`用例「${c.q}」标注了不存在的记忆「${name}」，可选：${[...known].join("、")}`);
      }
    }
  }
}
