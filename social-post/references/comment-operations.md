# Chrome Comment Operations（零 API）

> last_verified: 2026-08-28
> scope: 使用已登入 Chrome，處理 Facebook／Instagram／Threads 可見文字留言；不使用 Meta API。

這是 P5 Comment Ops 的唯一共用流程。平台畫面細節仍要讀目標平台 reference，並以當下可見 UI 為準。

## 目錄

- 能力邊界與三種模式
- Canonical ledgers
- 選定範圍與讀取 Chrome 畫面
- 分類、草擬與一次性 permit
- 逐則送出與結果對帳
- 全批停止條件
- 平台 adapter 約束

## 能力邊界

- 能做：使用者啟動後，掃描指定貼文的可見留言、去重、同語言草擬、整批確認、逐則回覆、畫面驗證與稽核。
- 能做：當前 session 內，對低風險白名單留言做有上限的 `bounded_auto`；每一則仍建立一次性 permit。
- 不能做：24/7 背景監聽、Webhook 即時通知、無邊界 `auto_everything`、私訊派發、媒體／GIF 回覆、歷史全帳號爬取。
- Chrome 操作沒有官方公布的安全頻率。`maximum_actions_per_run` 是本機停損，不是平台保證。

## 三種模式

| mode | 行為 | 外部寫入 |
|---|---|---|
| `draft_only` | 掃描、記錄、分類、草擬 | 無 |
| `batch_confirm` | 預覽固定批次；使用者確認後逐則送出 | 預設 |
| `bounded_auto` | 只處理 policy 白名單、強身分、完整內容、低風險留言 | 僅限當前 session 明示授權與當輪上限 |

不把先前 session 的「你自己回」延用到新 session。分類為安全不等於取得送出權限。
`bounded_auto` 的授權會以有期限、指定平台／帳號／貼文且有次數上限的 grant 寫入 ledger；換 session、換貼文、到期、撤銷或達上限都失效。

## Canonical ledgers

- `data/comment_events.jsonl`：Chrome 可見留言 observation；同留言編輯時追加 observation，不覆寫。
- `data/reply_events.jsonl`：草稿、核准、送出前標記、驗證與對帳事件；append-only。
- `references/comment-policy.json`：通用分類與自動化停損；不得放帳號、Cookie、token 或私人留言。

先驗證：

```powershell
$env:PYTHONUTF8='1'
python scripts/comment_assistant.py validate
python scripts/comment_assistant.py queue --format json
```

所有寫入 command 預設 dry-run；確認 JSON 正確才加 `--write`。

## 1. 選定範圍

實際掃描前，取得或確認：

- platform：`facebook`／`instagram`／`threads`
- 預期登入帳號 `account_key`
- 指定貼文 permalink 與平台內 `post_key`
- mode 與本輪範圍；不要從首頁猜貼文

沒有 permalink 時先取得 permalink；無法可靠定位就只做 `draft_only`。只掃指定貼文目前可見的新留言，不巡整個帳號歷史。

## 2. 讀取 Chrome 畫面

需要實際掃描或送出時才載入 `chrome:control-chrome`。沿用已登入狀態，但：

- 不讀取或匯出 Cookie、local storage、密碼、token、Chrome profile。
- 不自動登入、不處理 2FA／CAPTCHA／checkpoint。
- 使用可見文字、可存取名稱與 live screenshot 核對；不依賴一組長期固定 CSS selector。
- 展開「更多留言／回覆／查看更多」後重新讀取；截斷本文、只顯示翻譯或未展開時，`body_complete=false`。
- 優先使用平台留言 ID 或 comment permalink。只能用作者＋時間＋文字定位時，`identity_confidence=weak`，禁止 `bounded_auto`。
- 自己的留言記 `is_own=true`；已看見自己的既有回覆記 `has_own_reply=true`。

每個 observation 至少記：

```json
{
  "platform": "instagram",
  "account_key": "expected-account",
  "post_key": "platform-post-id",
  "post_permalink": "https://platform.example/post/id",
  "platform_comment_id": "stable-id-if-visible",
  "author_key": "visible-author-handle",
  "author_display": "Visible name",
  "body": "完整留言文字",
  "body_complete": true,
  "is_own": false,
  "has_own_reply": false,
  "observed_at": "2026-08-28T12:00:00+08:00",
  "language": "zh-Hant"
}
```

以 JSON 檔或 stdin dry-run：

```powershell
python scripts/comment_assistant.py ingest <comments.json>
python scripts/comment_assistant.py ingest <comments.json> --write
```

重掃同一份可見內容會回報 `unchanged`，不新增事件。

## 3. 分類與草擬

每則草稿必須：

- 回覆留言者使用的語言；語言不明就人工確認。
- 回應實際內容，不複製同一句模板給多個人。
- 單行，不能含 `\r`／`\n`；留言框的 Enter 可能直接送出。
- 不杜撰承諾、價格、時程或技術事實。
- 只存即將真正輸入的最後文字；approval hash 綁這份文字。

白名單候選只有 `positive_reaction`、`gratitude`、`emoji_only`。問題、keyword 索取、客訴、客服、價格、合作、法律、安全、隱私、騷擾、敏感、spam、未知一律 review。大量 keyword 留言不逐則私訊；改用單一公開作者留言提供自助入口。

```powershell
python scripts/comment_assistant.py draft --comment-key <key> --session-id <current-session> `
  --text "最終單行回覆" --classification positive_reaction --risk low `
  --confidence 0.99 --language zh-Hant
```

先 dry-run，正確才加 `--write`。完成後重跑 `queue --format json`。

## 4. 核准與一次性 permit

`batch_confirm` 先向使用者顯示固定批次：平台、作者、原留言、最終回覆。使用者確認後，才為這批 intent 建 permit：

```powershell
python scripts/comment_assistant.py approve --intent-id <id> --approval-mode batch_confirm `
  --session-id <current-session> --write
```

`bounded_auto` 只能在使用者於當前 session 明示平台／帳號／貼文範圍並允許自動送出後使用。先把這次授權寫成有期限的 grant：

```powershell
python scripts/comment_assistant.py grant-auto --session-id <current-session> `
  --platform instagram --account-key <account> --post-key <post> `
  --maximum-actions 5 --ttl-minutes 15 --write
```

保存輸出的 `grant_id`，再跑：

```powershell
python scripts/comment_assistant.py queue --mode bounded_auto --format json
python scripts/comment_assistant.py approve --intent-id <id> --approval-mode bounded_auto `
  --grant-id <grant-id> --session-id <current-session> --write
```

只為 `bounded_auto_candidates` 建 permit。grant 的累計核准數不得超過 `maximum_actions_per_run`，即使分多次執行 `approve` 也不能重置。permit 綁定 session、platform、account、post、comment、reply hash、期限，使用一次即失效。需要提前停止時：

```powershell
python scripts/comment_assistant.py revoke-grant --grant-id <grant-id> `
  --session-id <current-session> --reason user_stopped_auto_reply --write
```

## 5. 逐則送出

每一則都依序完成，不能先全點再補紀錄：

1. 回到指定 permalink，重新確認帳號、貼文、留言作者、完整本文與 fingerprint。
2. 確認 reply composer 為空；有殘留文字就停。
3. **在任何可能送出的點擊／Enter 前**先寫 `send_started`：

   ```powershell
   python scripts/comment_assistant.py begin-send --intent-id <id> `
     --session-id <current-session> --write
   ```

4. 只輸入已核准的單行文字。使用當下 UI 的唯一送出動作一次。
5. 重新讀取該留言串；只有看到自己的帳號在正確層級出現完全相同文字，才記：

   ```powershell
   python scripts/comment_assistant.py finish-send --intent-id <id> --result sent `
     --session-id <current-session> --evidence "exact reply visible under target" --write
   ```

6. 若可能已點擊但無法確認，記 `unknown` 並停止整批，不得重送：

   ```powershell
   python scripts/comment_assistant.py finish-send --intent-id <id> --result unknown `
     --session-id <current-session> --reason browser_result_uncertain --write
   ```

7. 下一次先重新讀畫面對帳：

   ```powershell
   python scripts/comment_assistant.py reconcile --intent-id <id> --result sent `
     --session-id <current-session> --evidence "reply found after reload" --write
   ```

   只有明確證明未送出才可用 `--result not-sent`，並重新取得新 permit。

## 全批立即停止條件

- 登入頁、2FA、CAPTCHA、checkpoint、帳號限制或「請稍後再試」。
- 實際帳號、貼文、留言作者／本文與 ledger scope 不符。
- 留言被刪除、隱藏、編輯，或只剩 weak locator／不完整本文。
- 回覆按鈕、留言框、層級或送出控制無法可靠辨識。
- composer 已有文字、核准文字含換行、需要媒體／GIF／私訊。
- 可能已送出但沒有畫面驗證、網路中斷、頁面重載或使用者接管操作。
- 達本輪上限、短時間留言爆量，或回覆文字開始重複。

停止後保存現有 audit；不要為了清 queue 繼續點。最後執行 `validate`，回報 sent、needs_reconcile、deferred 與未處理數。

## 平台 adapter 約束

- Facebook：留言框 Enter 可能直接送出；所有回覆單行，送出前確認正確留言層級。
- Instagram：先展開完整回覆串；不要把同步到 Facebook 的互動誤當 IG 留言。
- Threads：回覆本身是一則 thread；確認帳號、父 thread 與新回覆 permalink／可見文字。

介面改版時只更新平台 adapter 說明與 live 定位，不改 domain ledger、permit 或狀態機。
Chrome 回傳不確定時也不可由 adapter 自行重試；只能寫入 `needs_reconcile`，重新檢視畫面後再以原 send attempt 對帳。
