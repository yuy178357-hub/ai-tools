# AI 精选 · 策展式 AI 工具导航

精选少量高质量 AI 工具，每条都写清"为什么值得用"。

- 纯静态单文件站点（无构建、无框架）
- 数据：`tools.json`（由 `seed.json` + `scripts/gen_tools.mjs` 生成）
- 交互：搜索 / 分类筛选 / 收藏（localStorage）/ 详情抽屉 / 提交工具
- 托管：GitHub Pages → https://yuy178357-hub.github.io/ai-tools/

## 目录结构
```
index.html        站点（含内联 TOOLS 兜底数组，由脚本自动同步）
tools.json        站点 fetch 的主数据源（脚本生成）
seed.json         单一数据源：人工策展的元数据（改这里）
scripts/gen_tools.mjs  生成器：seed → tools.json + 同步 index.html 内联
```

## 更新工具列表（工作流）
1. 编辑 `seed.json`（增删工具 / 改分类、标签、定价、配色、编辑精选）
2. 运行生成器：
   ```bash
   node scripts/gen_tools.mjs
   ```
   默认用 `seed.json` 里的策划 `rating` / `aiReason`。
3. 提交并推送 → GitHub Pages 自动重建。

### 接入 AI 打分（可选）
配置 OpenAI 兼容的 LLM，生成器会为每个工具调用 LLM 产出 `rating` + `aiReason`：
```bash
LLM_BASE_URL=https://your-endpoint/v1 LLM_API_KEY=sk-... LLM_MODEL=gpt-4o-mini \
  node scripts/gen_tools.mjs
```
未配置时静默回退到 `seed.json` 的策划值。

## 真实抓取（未来）
`gen_tools.mjs` 的 `collect()` 目前直接返回 seed。要接真实聚合，把 `collect()`
替换为：从目录站 / RSS / 官方 API 抓取 → 映射成相同结构即可，其余管线不变。

## 本地预览
```bash
python3 -m http.server 8099
# 打开 http://127.0.0.1:8099/
```
