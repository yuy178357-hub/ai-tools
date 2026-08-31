#!/usr/bin/env node
/**
 * gen_tools.mjs — AI 工具站数据源生成器（v1）
 * ---------------------------------------------------------------
 * 单一数据源：seed.json（人工策展的元数据）
 * 真实采集：collect.mjs 的 enrich() 挂社区信号（GitHub stars + HN 热度）
 * 输出：
 *   1) tools.json        —— 站点 fetch 的主数据源（含 AI 打分 + 社区信号）
 *   2) index.html 内联 TOOLS 数组 —— 离线（file://）兜底，自动同步
 *
 * AI 打分：
 *   - 默认使用 seed.json 里的策划 rating / aiReason
 *   - 若配置 LLM_BASE_URL + LLM_API_KEY（OpenAI 兼容），
 *     则调用 LLM 为每个工具生成 { rating, aiReason }
 *
 * 用法：
 *   node scripts/gen_tools.mjs                  # 策划值 + 真实社区信号
 *   LLM_BASE_URL=https://x/v1 LLM_API_KEY=sk-... node scripts/gen_tools.mjs
 *   GH_TOKEN=ghp_xxx node scripts/gen_tools.mjs # 带 token 提 GitHub 速率
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { enrich } from "./collect.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SEED_PATH = join(ROOT, "seed.json");
const TOOLS_JSON = join(ROOT, "tools.json");
const INDEX_HTML = join(ROOT, "index.html");

// ---- 可选 LLM（OpenAI 兼容）----
const LLM_BASE = process.env.LLM_BASE_URL || "";
const LLM_KEY = process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

/** 调用 LLM 打分；失败返回 null 走策划值。 */
async function llmScore(t) {
  if (!LLM_BASE || !LLM_KEY) return null;
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是 AI 工具策展人。为给定工具产出 JSON：{\"rating\": 1-5 的数字, \"aiReason\": 一句中文推荐理由(≤40字，说清它凭什么值得用)}。只输出 JSON。" },
          { role: "user", content: `工具: ${t.name}\n分类: ${t.category}\n标签: ${(t.tags || []).join("、")}\n官网: ${t.url}` }
        ]
      })
    });
    const j = await res.json();
    const c = JSON.parse(j.choices?.[0]?.message?.content || "{}");
    if (typeof c.rating === "number" && c.aiReason) return c;
  } catch (e) {
    console.warn("  ⚠ LLM 打分失败，回退策划值：", t.name);
  }
  return null;
}

async function main() {
  const seed = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  const enriched = await enrich(seed); // 接真实抓取 / 社区评分

  const tools = [];
  for (const t of enriched) {
    const scored = await llmScore(t);
    const { repo, phSlug, ...rest } = t; // 去掉内部字段，不进公开产物
    tools.push({
      name: rest.name,
      emoji: rest.emoji,
      category: rest.category,
      tags: rest.tags,
      pricing: rest.pricing,
      rating: scored ? Math.round(scored.rating * 10) / 10 : rest.rating,
      aiReason: scored ? scored.aiReason : rest.aiReason,
      url: rest.url,
      editorPick: !!rest.editorPick,
      c1: rest.c1,
      c2: rest.c2,
      ...(rest.community ? { community: rest.community } : {})
    });
  }

  // 1) tools.json
  writeFileSync(
    TOOLS_JSON,
    JSON.stringify({ updated: new Date().toISOString().slice(0, 10), tools }, null, 2) + "\n"
  );

  // 2) 注入 index.html 内联兜底（标记之间；首次运行自动补标记）
  let html = readFileSync(INDEX_HTML, "utf8");
  const START = "/* TOOLS:AUTO:START */";
  const END = "/* TOOLS:AUTO:END */";
  const entries = tools.map((t) => "  " + JSON.stringify(t)).join(",\n");
  const block = `${START}\n${entries}\n${END}`;
  // 用 indexOf 切片替换，避免 START/END 含正则元字符（()*）导致正则匹配失败
  const si = html.indexOf(START);
  const ei = html.indexOf(END);
  if (si !== -1 && ei !== -1 && ei > si) {
    html = html.slice(0, si) + block + html.slice(ei + END.length);
  } else {
    html = html.replace(/(?:const|let) TOOLS = \[[\s\S]*?\];/, `let TOOLS = [\n${block}\n];`);
  }
  writeFileSync(INDEX_HTML, html);

  const withCommunity = tools.filter((t) => t.community).length;
  console.log(`✅ 生成完成：${tools.length} 个工具 → tools.json + index.html 内联`);
  console.log(`   社区信号：${withCommunity}/${tools.length} 个工具获得（GitHub/HN）`);
  console.log(`   AI 打分：${LLM_BASE ? "已启用 LLM (" + LLM_MODEL + ")" : "未配置，使用 seed 策划值"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
