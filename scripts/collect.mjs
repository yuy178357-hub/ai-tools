#!/usr/bin/env node
/**
 * collect.mjs — 真实抓取 / 社区信号源（v1）
 * ---------------------------------------------------------------
 * 输入：seed.json（工具元数据，开源工具可带 repo 字段）
 * 输出：enrich(seed) => 带 community 字段的工具数组
 *
 * 社区信号源（均无需 key 即可跑，失败优雅跳过，保留策划值）：
 *   - GitHub REST API   —— 读 repo 的 stars（开源工具，60/hr 免 key）
 *   - Hacker News Algolia —— 工具名历史最高 points（社区热度代理）
 *   - Product Hunt v2 GraphQL —— 有 PH_TOKEN 才跑，取 votes（可选）
 *
 * 说明：
 *   - community.score 是 0-5 的“社区热度归一分”，不是权威评分，
 *     仅作为策展 rating 的旁证，不覆盖人工打分。
 *   - 所有网络调用都带超时 + try/catch，单条失败不影响其他工具。
 *
 * 用法：
 *   node scripts/collect.mjs              # 单独跑，写 tools_community.json
 *   在 gen_tools.mjs 中被 import 并调用
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const GH_TOKEN = process.env.GH_TOKEN || "";
const PH_TOKEN = process.env.PH_TOKEN || "";          // Developer Token（优先，pht_xxx）
const PH_CLIENT_ID = process.env.PH_CLIENT_ID || "";   // OAuth App（PH_TOKEN 不存在时降级用）
const PH_CLIENT_SECRET = process.env.PH_CLIENT_SECRET || "";

/**
 * 获取 PH access token（client_credentials flow）。
 * 缓存在模块级别，进程内复用，避免每次请求都换 token。
 */
let _phAccessToken = null;
async function getPhToken() {
  if (_phAccessToken) return _phAccessToken;
  // Developer Token 优先（直接用，不需要换取）
  if (PH_TOKEN) { _phAccessToken = PH_TOKEN; return PH_TOKEN; }
  // 否则走 OAuth App client_credentials 降级
  if (!PH_CLIENT_ID || !PH_CLIENT_SECRET) return null;
  try {
    const res = await fetch("https://api.producthunt.com/v2/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: PH_CLIENT_ID,
        client_secret: PH_CLIENT_SECRET,
        grant_type: "client_credentials"
      })
    });
    const j = await res.json();
    if (j.access_token) { _phAccessToken = j.access_token; return _phAccessToken; }
  } catch (e) { console.warn("  ⚠ PH token 获取失败：", e.message); }
  return null;
}

// Product Hunt slug 映射（无 token 时不生效；slug 不准时优雅返回 null）
const PH_SLUGS = {
  "ChatGPT":"chatgpt", "Claude":"claude", "Midjourney":"midjourney", "Cursor":"cursor",
  "GitHub Copilot":"github-copilot", "Runway":"runwayml", "Pika":"pika", "ElevenLabs":"eleven-labs",
  "Suno":"suno", "Perplexity":"perplexity-ai", "Gamma":"gamma", "HeyGen":"heygen",
  "Stable Diffusion":"stable-diffusion", "FLUX":"flux1", "Sora":"sora", "Claude Code":"claude-code",
  "Kimi":"kimi", "DeepSeek":"deepseek", "Manus":"manus", "Figma AI":"figma-ai",
  "ChatGPT Search":"chatgpt-search", "Genspark":"genspark", "Windsurf":"windsurf", "Cline":"cline",
  "Veo":"veo", "Hailuo (MiniMax)":"hailuo", "Grok":"grok", "Gemini":"gemini",
  "Notion AI":"notion-ai", "Jasper":"jasper", "即梦 AI":"jimeng", "可灵 AI":"kling-ai",
  "通义千问 Qwen":"qwen", "Mistral (Le Chat)":"mistral-le-chat",
  "Meta AI (Llama)":"meta-ai", "Tabnine":"tabnine",
  "OpenAI Codex":"openai-codex", "Whisper":"whisper", "ChatPDF":"chatpdf",
  "秘塔 AI 搜索":"metaso", "Udio":"udio",
  // 2026-09 新增工具
  "GPT Image 2":"dall-e-3",   // DALL·E 3 PH 条目由 GPT Image 2 接棒
  "豆包 Doubao":"doubao", "文心助手":"wenxin-ai", "智谱清言 ChatGLM":"zhipu-ai",
  "文心快码 Comate":"baidu-comate", "腾讯 CodeBuddy":"codebuddy",
  "Accio":"accio-com", "Devv AI":"devv-ai", "天工 Skywork":"tiangong-ai"
};

/** 带超时的 JSON GET */
async function fetchJSON(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** 并发限制 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** GitHub stars（repo: "owner/name"） */
async function ghStars(repo) {
  const headers = { accept: "application/vnd.github+json" };
  if (GH_TOKEN) headers.authorization = `Bearer ${GH_TOKEN}`;
  const j = await fetchJSON(`https://api.github.com/repos/${repo}`, { headers });
  return j.stargazers_count ?? null;
}

/** HN 历史最高 points（社区讨论热度代理） */
async function hnPoints(name) {
  const q = encodeURIComponent(name);
  const j = await fetchJSON(
    `https://hn.algolia.com/api/v1/search?query=${q}&tags=story&hitsPerPage=20`
  );
  let max = 0;
  for (const h of j.hits || []) {
    if (h.points && h.points > max) max = h.points;
  }
  return max;
}

/** Product Hunt votes（需 access token + slug）；从 getPhToken() 缓存拿 token */
async function phVotes(slug, token) {
  if (!token || !slug) return null;
  const j = await fetchJSON("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({
      query: `query($slug:String!){post(slug:$slug){votesCount}}`,
      variables: { slug }
    })
  });
  return j?.data?.post?.votesCount ?? null;
}

/** 0-5 归一：stars 占 70%，hn 占 30%（log 缩放，避免长尾极端值） */
function normalizeScore({ stars, hn }) {
  let s = 0;
  if (typeof stars === "number") {
    s += 0.7 * (Math.min(5, (Math.log10(stars + 1) / Math.log10(100001)) * 5));
  }
  if (typeof hn === "number") {
    s += 0.3 * (Math.min(5, (Math.log10(hn + 1) / Math.log10(2001)) * 5));
  }
  return Math.round(s * 10) / 10;
}

/**
 * enrich：给 seed 每项附加 community 信号。
 * 任何源失败都跳过该源，最终无信号的工具 community 为 undefined。
 */
export async function enrich(seed) {
  const out = [];
  for (const t of seed) {
    const community = { sources: [] };
    try {
      if (t.repo) {
        const stars = await ghStars(t.repo);
        if (typeof stars === "number") {
          community.githubStars = stars;
          community.sources.push("github");
        }
      }
    } catch (e) {
      console.warn(`  ⚠ GitHub 信号失败：${t.name}`);
    }
    try {
      const hn = await hnPoints(t.name);
      if (hn > 0) {
        community.hnMaxPoints = hn;
        community.sources.push("hn");
      }
    } catch (e) {
      console.warn(`  ⚠ HN 信号失败：${t.name}`);
    }
    // 可选 PH（Developer Token 优先；无则降级 OAuth App；slug 来自 PH_SLUGS 映射）
    const slug = t.phSlug || PH_SLUGS[t.name];
    if ((PH_TOKEN || (PH_CLIENT_ID && PH_CLIENT_SECRET)) && slug) {
      try {
        const token = PH_TOKEN || await getPhToken();
        if (token) {
          const v = await phVotes(slug, token);
          if (typeof v === "number") {
            community.phVotes = v;
            community.sources.push("producthunt");
          }
        }
      } catch (e) {
        console.warn(`  ⚠ PH 信号失败：${t.name}`);
      }
    }
    community.updatedAt = new Date().toISOString();
    if (community.sources.length) {
      community.score = normalizeScore({
        stars: community.githubStars,
        hn: community.hnMaxPoints
      });
    }
    out.push({ ...t, community: community.sources.length ? community : undefined });
  }
  return out;
}

export { ghStars, hnPoints, phVotes, normalizeScore };

// 直接运行：读 seed → enrich → 写 tools_community.json
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const seed = JSON.parse(readFileSync(join(ROOT, "seed.json"), "utf8"));
  const enriched = await enrich(seed);
  const n = enriched.filter((t) => t.community).length;
  writeFileSync(
    join(ROOT, "tools_community.json"),
    JSON.stringify(enriched, null, 2) + "\n"
  );
  console.log(`✅ collect 完成：${n}/${enriched.length} 个工具获得社区信号 → tools_community.json`);
}
