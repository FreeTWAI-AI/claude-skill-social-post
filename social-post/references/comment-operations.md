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
- `data/browser_scan_requests.jsonl`：使用者／當前 session 在掃描前指定的帳號、貼文與期限；append-only，Chrome receipt 不能自己改 scope。
- 同一檔也追加 `browser_scan_completed`；保留留言數、零結果與展開證據，避免把「尚未掃描」誤判成「掃過但沒有留言」。
- `references/comment-policy.json`：通用分類與自動化停損；不得放帳號、Cookie、token 或私人留言。
- 正式 policy 的 `live_browser_actuation_enabled=false` 是獨立 kill switch：safe preview、scan request、草稿與 action 可用，但所有 live Chrome receipt 寫入 canonical ledger 都停用。測試 fixture 必須顯式設成 `true`，使用者批准本身不能打開它。
- `comment-capabilities.json`：closed-world 能力義務；contract、真瀏覽器 fixture、live 三平台與 bounded auto 不互相冒充完成。

先驗證：

```powershell
$env:PYTHONUTF8='1'
python scripts/comment_assistant.py validate
python scripts/comment_assistant.py queue --format json
python scripts/comment_capability_gate.py
```

所有寫入 command 預設 dry-run；確認 JSON 正確才加 `--write`。
目前 release 的 live Chrome mutation 預設停用；下列 `browser-scan／begin／finish／reconcile --write` 指令只有隔離 contract fixture 明示 opt-in 時可成功，不能視為已通過登入 Meta canary。

## 1. 選定範圍

實際掃描前，取得或確認：

- platform：`facebook`／`instagram`／`threads`
- 預期登入帳號 `account_key`
- 指定貼文 permalink 與平台內 `post_key`
- mode 與本輪範圍；不要從首頁猜貼文

沒有 permalink 時先取得 permalink；無法可靠定位就只做 `draft_only`。只掃指定貼文目前可見的新留言，不巡整個帳號歷史。

先把這次 read-only 目標寫入 ledger，保存輸出的 `scan_request_id`：

```powershell
python scripts/comment_assistant.py browser-scan-request --platform instagram `
  --account-key <account> --post-key <post> --post-permalink <permalink> `
  --session-id <current-session> --ttl-minutes 10 --write
```

scan request 由操作方先建立，Chrome 只能回綁；換帳號、換貼文、換 session 或逾時都要重建。

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
  "observed_parent_post_permalink": "https://platform.example/post/id",
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

依當下 DOM 建立短命 locator plan，交給 `scripts/comment_chrome_actuator.mjs` 的 `scanPost()` 產生 `chrome-comment-adapter.md` 定義的 scan receipt；locator plan 不跨頁面／改版保存。以 JSON 檔或 stdin dry-run：

```powershell
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session>
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session> --write
```

`browser-scan` 會驗證 stored request、session、期限、登入狀態、平台 host、帳號／貼文／每則留言的 observed parent、布林型別與單次掃描上限；成功時追加 completion event。重送完全相同 scan 會回報 `unchanged`，也不重複追加 completion。raw `ingest` 只保留給舊資料與本地測試，不能作為 live Chrome 掃描入口。

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

1. 先從 canonical ledger 產生不可變 action envelope：

   ```powershell
   python scripts/comment_assistant.py browser-action --intent-id <id> `
     --session-id <current-session>
   ```

2. 回到 action 指定 permalink，從 fresh DOM snapshot 建立 locator plan；用 `comment_chrome_actuator.mjs` 的 `prepareReply()` 重新確認帳號、貼文、強留言 anchor、作者、完整本文，以及同一父留言內的 reply trigger／空 composer／唯一 submit。先完整展開回覆並確認 exact-own baseline 為 0，再填入 action 內已核准文字；receipt 會綁定重算後的 reply hash、action digest、plan digest 與 preparation ID。
3. **在任何可能送出的點擊／Enter 前**，以 `comment_chrome_claim_bridge.mjs` 讓 ledger 驗證 preparation 並原子寫入 `send_started`：

   ```powershell
   python scripts/comment_assistant.py browser-begin <preflight.json> `
     --intent-id <id> --session-id <current-session> --write
   ```

4. CLI 只有在 durable commit 成功後才輸出結構化 `SUBMIT_CLAIM`；`submitOnce()` 只接受逐欄綁定的 claim callback，不接受裸 `WRITE_OK`。process-wide reservation 與 append-only ledger 共同阻擋同程序併發、actor 重建與跨程序重播。claim 後不得改字、換 plan 或自動重試。
5. 重新完整展開並讀取該留言串，用 `inspectResult()` 建立 post-submit receipt。只有 exact-own baseline 原本為 0、現在於正確父層恰好出現一份完全相同文字、送後總回覆數至少為送出前基線＋1，而且所有 reply item 都可檢查，所有驗證旗標才可為 `true`；receipt 也必須沿用 preparation／claim／preflight。再交由 ledger 分類：

   ```powershell
   python scripts/comment_assistant.py browser-finish <result.json> `
     --intent-id <id> --session-id <current-session> --write
   ```

   - 確認送出且完整驗證：`sent_verified`
   - 明確沒有執行送出、已不可能送出，而且畫面沒有 exact／own 成功證據：`failed`
   - 其餘狀況一律：`needs_reconcile`，立即停止整批且不得重送

6. 下一次先重新讀畫面，建立 `chrome-comment-adapter.md` 定義的 fresh reinspection receipt，再對帳：

   ```powershell
   python scripts/comment_assistant.py browser-reconcile <reinspection.json> `
     --intent-id <id> --session-id <current-session> --write
   ```

   找到 own-account exact reply且目前總回覆數至少為送出前基線＋1，才能記 `reconciled_sent`；完整展開、沒有任何 own-author reply，而且總數未低於基線時，才能記 `reconciled_not_sent`。文字被平台正規化、回覆總數倒退或其他不確定情況都不改 ledger、不重送。raw `begin-send`／`finish-send`／`reconcile` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕；live P5 必須走 browser bridge。

## 全批立即停止條件

- 登入頁、2FA、CAPTCHA、checkpoint、帳號限制或「請稍後再試」。
- 實際帳號、貼文、留言作者／本文與 ledger scope 不符。
- 留言被刪除、隱藏、編輯，或只剩 weak locator／不完整本文。
- 回覆按鈕、留言框、層級或送出控制無法可靠辨識。
- composer 已有文字、核准文字含換行、需要媒體／GIF／私訊。
- 可能已送出但沒有畫面驗證、網路中斷、頁面重載或使用者接管操作。
- 同 session、同平台、同帳號與同貼文已有任何 active `needs_reconcile`；domain 會同時阻擋新的 `browser-action` 與 `browser-begin`，完成 reconcile 才解鎖。
- 達本輪上限、短時間留言爆量，或回覆文字開始重複。

停止後保存現有 audit；不要為了清 queue 繼續點。最後執行 `validate`，回報 sent、needs_reconcile、deferred 與未處理數。

## 平台 adapter 約束

- Facebook：留言框 Enter 可能直接送出；所有回覆單行，送出前確認正確留言層級。
- Instagram：先展開完整回覆串；不要把同步到 Facebook 的互動誤當 IG 留言。
- Threads：回覆本身是一則 thread；確認帳號、父 thread 與新回覆 permalink／可見文字。

介面改版時只更新平台 adapter 說明與 live 定位，不改 domain ledger、permit 或狀態機。
Chrome 回傳不確定時也不可由 adapter 自行重試；只能寫入 `needs_reconcile`，重新檢視畫面後再以原 send attempt 對帳。

Fixture 驗證入口是 `node scripts/comment_chrome_actuator_test.mjs`；真瀏覽器可在 Browser Plugin session 對 localhost 呼叫 `comment_fixture_browser_e2e.mjs`。fixture 的 URL 映射只有 loopback＋`testOnly` 才能啟用，不能放寬正式 Meta host。
