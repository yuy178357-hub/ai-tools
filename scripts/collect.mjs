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
const PH_TOKEN = process.env.PH_TOKEN || "";

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

/** Product Hunt votes（需 PH_TOKEN + slug） */
async function phVotes(slug) {
  if (!PH_TOKEN || !slug) return null;
  const body = {
    query: `query($slug:String!){post(slug:$slug){votesCount}}`,
    variables: { slug }
  };
  const j = await fetchJSON("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + PH_TOKEN,
      accept: "application/json"
    },
    body: JSON.stringify(body)
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
    // 可选 PH（仅配置了 token 时）
    if (PH_TOKEN && t.phSlug) {
      try {
        const v = await phVotes(t.phSlug);
        if (typeof v === "number") {
          community.phVotes = v;
          community.sources.push("producthunt");
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
