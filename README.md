# social-post skill

一個可安裝到 Codex 或 Claude Code 的社群內容 Skill：學習本機聲線、規劃內容、撰寫平台化貼文、經確認後發布，並把跨平台洞察保存成可驗證的結構化資料。

目前版本：**v2.2.0**。

## v2.2.0

- 新增 append-only `corrections.jsonl`：修正發布時間、片長或舊快照時，不再覆寫歷史 event。
- 新增 `metric_qualifiers`：`rounded`、`upper_bound`、`visual_estimate` 等平台顯示精度會一路保留到 summary。
- Public sync 在寫入前做 privacy preflight，並用 managed manifest 追蹤可安全同步的通用檔案。
- 公開包改為「通用引擎＋虛構案例＋匿名規則／公式」；真實帳號案例、數據、聲線與私人平台決策不再出現在目前發布樹。

## 安裝

```bash
git clone https://github.com/Hao0321/claude-skill-social-post.git
```

Codex（Windows PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills" | Out-Null
Copy-Item -Recurse ".\claude-skill-social-post\social-post" "$env:USERPROFILE\.codex\skills\social-post"
```

Claude Code：把目的地改成 `.claude\skills\social-post`。macOS／Linux 可複製到 `~/.codex/skills/social-post/` 或 `~/.claude/skills/social-post/`。

首次使用先建立只存在本機的個人檔：

```powershell
cd social-post
Copy-Item style_profile.example.md style_profile.md
Copy-Item content_plan.example.md content_plan.md
```

再把 `voice_quick.md` 與 `current_brief.md` 的 placeholder 換成自己的方向。

## 五個 Mode

| Mode | 用途 |
|---|---|
| P0 Plan | 規劃內容與實驗 |
| P1 Learn Voice | 從已授權樣本學本機聲線 |
| P2 Draft／Publish | 撰稿；當輪確認後才發布 |
| P3 Log Outcome | 保存貼文、快照、帳號總覽與 corrections |
| P4 Optimize Patterns | 對齊 maturity 後做跨篇／跨平台比較 |

## Outcome 快速開始

```powershell
$env:PYTHONUTF8='1'
python scripts/log_outcome.py references/outcome-bundle.example.json
python scripts/self_test.py
python scripts/social_data.py validate
python scripts/social_data.py summary --series demo-series
```

正式寫入時才加 `--write`。修正既有 event 可參考 [`correction-bundle.example.json`](social-post/references/correction-bundle.example.json)。

## 隱私邊界

公開 repo 只收 schema、工具、匿名規則與明示為 fictional 的例子。不要提交：

- `style_profile.md`、`content_plan.md`、`drafts/`；
- `data/*.jsonl` 的真實 outcome／correction；
- 原始洞察截圖、caption archive、帳號名稱、個人路徑；
- 從私人數據升級出的規則、公式或案例。

## 驗證

```powershell
python social-post/scripts/self_test.py
python social-post/scripts/social_data.py validate
```

## License

[MIT](LICENSE)。Copyright holder：Hao0321 contributors。
