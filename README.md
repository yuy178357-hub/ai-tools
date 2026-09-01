# AI 精选 · 策展式 AI 工具导航

精选少量高质量 AI 工具，每条都写清"为什么值得用"。

- 纯静态单文件站点（无构建、无框架）
- 数据：`tools.json`（由 `seed.json` + `scripts/gen_tools.mjs` 生成，含真实社区信号）
- 交互：搜索 / 分类筛选 / 收藏（localStorage）/ 详情抽屉 / 提交工具
- 托管：GitHub Pages → https://yuy178357-hub.github.io/ai-tools/

## 目录结构
```
index.html              站点（含内联 TOOLS 兜底数组，由脚本自动同步）
tools.json              站点 fetch 的主数据源（脚本生成）
seed.json               单一数据源：人工策展的元数据（改这里）
scripts/collect.mjs     真实采集：GitHub 星标 + HN 讨论热度 → community 信号
scripts/gen_tools.mjs   生成器：seed → enrich(社区信号) → tools.json + 同步 index.html 内联
tools_community.json    仅 collect 单独跑时的中间产物（可选）
```

## 更新工具列表（工作流）
1. 编辑 `seed.json`（增删工具 / 改分类、标签、定价、配色、编辑精选；开源工具可加 `repo:"owner/name"`）
2. 运行生成器（会实时抓取 GitHub / HN 社区信号）：
   ```bash
   node scripts/gen_tools.mjs
   ```
   默认用 `seed.json` 里的策划 `rating` / `aiReason`；社区信号挂到每个工具的 `community` 字段。
3. 提交并推送 → GitHub Pages 自动重建。

### 接入 AI 打分（可选）
配置 OpenAI 兼容的 LLM，生成器会为每个工具调用 LLM 产出 `rating` + `aiReason`：
```bash
LLM_BASE_URL=https://your-endpoint/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini \
  node scripts/gen_tools.mjs
```
未配置时静默回退到 `seed.json` 的策划值。

### 社区信号源（collect.mjs）
任何源失败都优雅跳过，保留策划值：
- **GitHub REST API** —— 开源工具的 `repo` 星标（免 key，60/hr；`GH_TOKEN` 可提速率）
- **Hacker News Algolia** —— 工具名历史最高 points（社区热度代理，免 key）
- **Product Hunt v2 GraphQL** —— 配置 `PH_TOKEN`（Developer Token）时直接用；无则降级走 `PH_CLIENT_ID` + `PH_CLIENT_SECRET`（client_credentials）。

`community.score` 是 0-5 的"社区热度归一分"（stars 70% + HN 30%，log 缩放），
作为策展 `rating` 的**旁证**，不覆盖人工打分；已在卡片「🔥 热度」角标与详情抽屉展示。

### 启用 Product Hunt votes
1. 在 Product Hunt 开发者后台（https://www.producthunt.com/v2/oauth/register）创建应用，拿到 **Developer Token**。
2. 给仓库 `yuy178357-hub/ai-tools` 添加 **Actions secret** `PH_TOKEN`（值填 token）。
3. 自动刷新工作流会读取该 secret 抓取 votes；也可本地 `PH_TOKEN=pht_xxx node scripts/gen_tools.mjs` 手动跑。
4. `scripts/collect.mjs` 内置 `PH_SLUGS` 名称→slug 映射，覆盖全部 63 个工具，无需逐个在 `seed.json` 填 `phSlug`。

## 自动刷新（GitHub Actions）
`.github/workflows/refresh.yml` 每天 08:17（北京时间）自动抓取社区信号并重新生成
`tools.json` + `index.html` 内联兜底，仅当有变化才提交。也可在 Actions 页面手动 `Run workflow`。

## 本地预览
```bash
python3 -m http.server 8099
# 打开 http://127.0.0.1:8099/
```
