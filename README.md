# social-post skill

一個可安裝到 Codex 或 Claude Code 的社群內容 Skill：學習本機聲線、規劃內容、撰寫平台化貼文、經確認後發布，以已登入 Chrome 受控管理 FB／IG／Threads 留言，並把跨平台洞察保存成可驗證的結構化資料。

目前版本：**v2.4.0**。

## v2.4.0

- P5 從操作手冊升級成可執行的 Chrome action／receipt bridge：`browser-scan-request → browser-scan → browser-action → browser-begin → browser-finish → browser-reconcile`。
- 掃描 scope 會先寫入有 session 與期限的 append-only request；Chrome 不能從目前頁面自行決定帳號或貼文，每則 comment anchor 也必須綁定核准貼文。
- 每次送出會綁定 action、一次性 permit、session、平台／帳號／貼文／留言、本文 fingerprint 與最終 reply hash。
- 送出前驗證貼文 URL、空白 composer、填入後 exact text 與 60 秒 freshness；送出後只有六項畫面證據全成立才記為 `sent_verified`。
- 任何 timeout、導頁、矛盾狀態或不明結果一律 `needs_reconcile`，不自動重點；重新檢視仍不確定就保持 `NO_CHANGE`。
- 正式 ledger 會拒絕可繞過 bridge 的 raw begin／finish／reconcile；三平台匿名 fixture 與負向測試可安全開源。

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

## 六個 Mode

| Mode | 用途 |
|---|---|
| P0 Plan | 規劃內容與實驗 |
| P1 Learn Voice | 從已授權樣本學本機聲線 |
| P2 Draft／Publish | 撰稿；當輪確認後才發布 |
| P3 Log Outcome | 保存貼文、快照、帳號總覽與 corrections |
| P4 Optimize Patterns | 對齊 maturity 後做跨篇／跨平台比較 |
| P5 Comment Ops | 以 Chrome 受控掃描、草擬、核准及回覆留言 |

## Comment Ops 快速開始

P5 不串 Meta API，也不匯出 Chrome Cookie 或 session。預設是 `batch_confirm`，不提供 24/7 背景監聽或無邊界的全自動模式。實際掃描與送出需要執行環境提供 `chrome:control-chrome`、使用者已開啟的 Chrome 與既有登入狀態；沒有瀏覽器控制能力時仍可使用草稿、政策、ledger 與測試功能。

```powershell
$env:PYTHONUTF8='1'
python scripts/comment_assistant.py validate
python scripts/comment_assistant.py queue --format json
python scripts/comment_self_test.py
```

實際流程與停損條件見 [`comment-operations.md`](social-post/references/comment-operations.md)，JSON bridge contract 見 [`chrome-comment-adapter.md`](social-post/references/chrome-comment-adapter.md)。定位依當下可見 DOM／accessibility state 建立，不使用一組長期寫死的 Meta selector。所有 ledger command 預設 dry-run，明確加上 `--write` 才會寫入本機。

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
- `comment_events.jsonl`、`reply_events.jsonl`、`browser_scan_requests.jsonl` 的真實留言、作者、貼文、回覆與掃描目標；
- 原始洞察截圖、caption archive、帳號名稱、個人路徑；
- Cookie、session、access token、瀏覽器 profile、登入資料；
- 從私人數據升級出的規則、公式或案例。

## 驗證

```powershell
python social-post/scripts/self_test.py
python social-post/scripts/social_data.py validate
python social-post/scripts/comment_assistant.py validate
```

## License

[MIT](LICENSE)。Copyright holder：Hao0321 contributors。
