# Chrome Comment Operations（零 API）

> last_verified: 2026-09-05
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

- 流程涵蓋：指定貼文／原生留言的來源綁定回填、去重、同語言草擬、確認、逐則回覆與稽核；目前 production 送出仍 default-off，可執行狀態以 `chrome-comment-adapter.md` 為準。
- IG exact-target intake 與限一則、最長 300 秒的已授權 canary lease 已完成一次真實送出及原生子回覆查證；即時結果不明先停下，真正重啟後唯讀 recovery 已將同一筆原 attempt 結算為 `sent`，沒有重送。這不是 `bounded_auto` 啟用或三平台完成；白名單 batch 自動化仍需獨立能力驗證與當前 session 授權。
- 不能做：24/7 背景監聽、Webhook 即時通知、無邊界 `auto_everything`、私訊派發、媒體／GIF 回覆、歷史全帳號爬取。
- Chrome 操作沒有官方公布的安全頻率。`maximum_actions_per_run` 是本機停損，不是平台保證。
- `TRUSTED_CHROME_HOST_RESOLVER` 已 source-wire 到固定版本的 Chrome browser client，只能 claim 已存在、URL 完全相符且 read-only 的 Chrome tab；caller 不能注入 agent／browser／tab／resolver，它也不能自行啟動 Chrome、導覽或從 JSON、設定值、fixture 安裝 authority。離線 source contract 已通過，但尚無已登入 FB／IG／Threads permalink canary，也尚未把 process-local host attestation 接成可升級 canonical obligation 的 production promotion receipt。因此它與 `STABLE_NODE_FRAME_MAPPING`、`THREE_PLATFORM_BROWSER_FIXTURE`、`THREE_PLATFORM_LIVE_DRAFT`、`LIVE_BATCH_CONFIRM`、`LIVE_BOUNDED_AUTO` 六項全部維持 open。以下 live 流程是 fail-closed 契約與未來操作規格，不代表已可在 production 自動送出。
- `test_only_full_lifecycle_mapping` 現在可在 fake fixture 內驗證三平台 exact `expand → reply_trigger → composer_fill → submit_preflight → finish → recovery_reinspection`、每階段雙讀、frame／document epoch／comment／parent／node-role continuity、前階一次性 consume、finish exact-own cardinality 與 recovery reinspection。這個 evidence class 不在 production `REQUIREMENTS`，沒有 receipt path／writer／trusted verifier；所有 boundary flags 固定 test-only、promotion／browser receipt／live actuation／live plan minting 固定為 false。序列化證據只可當 non-authoritative structural report，不能取代 in-process brand、不能升級 `STABLE_NODE_FRAME_MAPPING`，也不能讓 fixture 進入 live。

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
- target-only intake 另追加 `browser_target_observation_completed`：只證明指定原生父留言已讀取，固定一則，`whole_post_complete=false`、`reply_thread_complete=false`，不能冒充整篇掃完或零回覆。其 exact scope 與 provenance digest 沿用至 draft／action。
- `references/comment-policy.json`：通用分類與自動化停損；不得放帳號、Cookie、token 或私人留言。
- 正式 policy 的 `live_browser_actuation_enabled=false` 關閉泛用 production 送出；只讀回填另受 `live_browser_scan_enabled` 控制。canary 必須先有已核准 action，再以 `browser_canary_lease_issued` 綁定當前 session、exact action／reply／scope、source digest、最長 300 秒及一次性上限；僅來源持有的候選入口可消耗。lease 不修改 policy、不能升級 capability，caller 不能用自製 preparation 繞過來源檢查。
- `.rd/capability-ledger.json`：私版唯一 closed-world canonical authority，涵蓋產品核心與留言流程；只有這裡能升降狀態。receipt 與測試結果只能提供待驗證證據，不能自行改 ledger。
- `comment-capabilities.json`：由 canonical ledger 選取留言 obligation 後生成的 non-authoritative public structural report，帶 canonical SHA-256 與 projection payload SHA-256；不得手改。只有能取得 private canonical parity 或受信任 attestation 的流程才能確認來源；public-only `--projection-only` 不能證明 verified 狀態、不能升級 capability，也不能打開 live mutation。

### Promotion authority 與 exact DAG

static JSON receipt、`PASS`、來源 hash、fixture receipt、self-authored boolean 或 projection 自身 hash 都不能升級 production。`comment_capability_trusted_host_verifier.py` 只提供 fail-closed 的既有 session challenge／response promotion 邊界：逐欄綁定 authority、session、run、source snapshot、有效時間與三平台結果，並要求 browser launch／mutation 為精確整數 `0`。JavaScript runtime authority 已 source-wire 到既有 Chrome session，但尚未完成已登入三平台 canary，也尚未將它的 process-local attestation 接入這個 promotion verifier；`THREE_PLATFORM_BROWSER_FIXTURE` 只有 test-only raw／envelope verifier，另外四個 live successor verifier 仍未接入。離線 test authority 只有明示 test mode 才能校準 schema，不能取代 genuine Chrome provenance、authenticated canary 或 child execution attestation。因此 production obligation 仍必須維持 open。

closed-world production-promotion dependency 如下，並強制 transitive closure；`promotion=false` 的 fixture 是獨立 test-only 品質證據，不是 live predecessor：

1. `TRUSTED_CHROME_HOST_RESOLVER`：無 predecessor。
2. `STABLE_NODE_FRAME_MAPPING`：依賴 `TRUSTED_CHROME_HOST_RESOLVER`。
3. `THREE_PLATFORM_BROWSER_FIXTURE`：`promotion=false`，沒有 production predecessor，永遠不得標成 `verified` 或解鎖 live successor。
4. `THREE_PLATFORM_LIVE_DRAFT`：直接依賴 `TRUSTED_CHROME_HOST_RESOLVER` 與 `STABLE_NODE_FRAME_MAPPING`。
5. `LIVE_BATCH_CONFIRM`：依賴 `THREE_PLATFORM_LIVE_DRAFT`。
6. `LIVE_BOUNDED_AUTO`：依賴 `LIVE_BATCH_CONFIRM`。

不得跳過 predecessor、把 `promotion=false` row 當 predecessor、加入未知節點、形成 cycle，或用空白／別名狀態繞過。任何 `promotion=false` row 即使有 source-bound verifier 與 PASS envelope，也只能校準 test-only 品質證據；canonical gate 與 production receipt facade 都必須拒絕 `status=verified`。每份 production evidence 必須逐欄綁定 obligation／gate／scope、product version、source revision、capability contract、policy、exact source inventory、run、有效時間與當前 session；依能力再綁定 platform、account、post、parent/comment、reply hash、grant、permit、claim、action 及 child execution receipt。

grant、permit、claim、action、execution receipt 與 `(platform, account, post, parent/comment)` 都必須 one-time；同一 parent 不得只更換 action ID 後重送，grant 有效期也不得超過 receipt 與當前 session 的共同有效窗。任何重複、未知或對帳不完整都進入 `needs_reconcile`／停止整批。fixture 永遠是 test-only evidence，不得升級 trusted host、live draft、live batch、bounded auto 或 `live_browser_actuation_enabled`。

先驗證：

```powershell
$env:PYTHONUTF8='1'
python scripts/comment_assistant.py validate
python scripts/comment_assistant.py queue --format json
python scripts/comment_capability_gate.py
# 只有更新 canonical ledger 後才執行下一行，再重新跑 gate
python scripts/comment_capability_gate.py --write-projection
```

`--write-projection` 只重建公開 structural report，不會也不能升級 canonical 狀態；`--projection-only` 沒有 private canonical parity 時只可回報 non-authoritative structural validity。

所有寫入 command 預設 dry-run；確認 JSON 正確才加 `--write`。
目前 release 的泛用 live Chrome 送出預設停用；來源綁定的只讀回填與單則 IG／Threads canary 是分開的窄入口。平台及 runtime 的實證狀態只以 `chrome-comment-adapter.md` 為準。下列分離式送出契約不代表 production 已啟用，也不能用隔離 fixture 的成功輸出宣稱通過登入 Meta canary。

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

若只處理一則已指定原生留言，使用來源持有的 `observeTargetComment(...)`，由它私下建立 `browser-target-observation-request`、雙讀同一目標並回填 `browser-target-observation`；不手填 live receipt。`document_binding` 是 tab／URL／完整作者與本文的 UI continuity，不是實體 epoch 或同 URL reload 保證；實際父貼文從可見 native anchor 取得。語言未辨識用 `und`，`has_own_reply=false` 不能作為可送出或不存在既有回覆的證明。

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

正式掃描只接受 production registry 內 source-controlled、trusted-host-resolved 且 canary-verified 的短命 plan；目前三平台尚無可用 live plan，因此 `scanPost()` fail closed。不得把當下 DOM 自製 selector、fake tab、caller resolver 或兩次空 viewport read 提升成 complete。test fixture 另走獨立 test-only 模組與 explicit cursor／monotonic count／terminal exhaustion contract。以 JSON 檔或 stdin dry-run：

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

目前單則 IG 候選另走 `executeCanaryReply({ intentId, sessionId, leaseId })`：當前 session 明確授權範圍、canonical draft／approval 與短命 lease 缺一不可。先核對正數 native reply count、展開後雙讀及零 own reply；選取父留言後原生 `@author ` 前綴須保留在核准文字中，preflight 如實記錄 nonempty native mention 與來源 selection evidence。只可 durable claim 一次、submit 一次；正確父層恰新增一則 exact-own native child 才作正向確認。未看見、載入中、timeout、父層／文字不符一律 unknown／`needs_reconcile` 並停止，不推導 absence，不重新送出；lease 到期也不解除既有 attempt。完整欄位與限制只維護在 `chrome-comment-adapter.md`。

以下為分離式 fixture／未來 production 契約，不是上述候選入口的替代呼叫方式：

每一則都依序完成，不能先全點再補紀錄：

1. 先從 canonical ledger 產生不可變 action envelope：

   ```powershell
   python scripts/comment_assistant.py browser-action --intent-id <id> `
     --session-id <current-session>
   ```

2. 回到 action 指定 permalink，先以 source-wired read-only host/document contract 核對 exact HTTPS host、post path、前後 URL、top-level root、document epoch 與 main-frame-only policy；這份 contract 仍可由測試 fake tab 執行，尚不等於 genuine Chrome provenance 或 authenticated canary。只有再完成真正 host binding、live locator revision 與 stable frame/node mapping，才可從 fresh DOM snapshot 建立 locator plan，並用 `comment_chrome_actuator.mjs` 的 `prepareReply()` 重新確認帳號、貼文、強留言 anchor、作者、完整本文，以及同一父留言內的 reply trigger／空 composer／唯一 submit。現在 live preparation 在任何 DOM inspection、reply expansion、trigger click 或 composer fill 以前固定 fail closed；只有 loopback `testOnly:true` fixture 執行後續契約。後續契約先以 `replyExhaustion` version 1 走完 target-scoped cursor traversal、monotonic discovered count、所有 expander、explicit terminal 與 terminal stable 雙讀；terminal count 必須等於仍可逐筆檢查的 reply collection。`0` reply／`0` expander 或兩次空 read 都不算完整。只有完成後且 exact-own baseline 為 0，才能碰 reply trigger、填入 action 內已核准文字；receipt 會綁定重算後的 reply hash、action digest、plan digest 與 preparation ID。
3. **在任何可能送出的點擊／Enter 前**，以 `comment_chrome_claim_bridge.mjs` 讓 ledger 驗證 preparation 並原子寫入 `send_started`：

   ```powershell
   python scripts/comment_assistant.py browser-begin <preflight.json> `
     --intent-id <id> --session-id <current-session> --write
   ```

4. CLI 只有在 durable commit 成功後才輸出結構化 `SUBMIT_CLAIM`；`submitOnce()` 只接受逐欄綁定的 claim callback，不接受裸 `WRITE_OK`。但呼叫 claim 以前，actuator 會先再次完成 reply exhaustion 並核對 composer；lazy scroll／later page 才出現 exact own reply或 expander、沒有 terminal cursor／traversal、count coverage 不完整時，claim 與 submit click 必須都維持 0。同一回執另含只留在 Node 記憶體的 version 1 finish capability；ledger 只存 nonce hash、action/session/scope binding digest、期限與 capability ID。process-wide reservation 與 append-only ledger 共同阻擋同程序併發、actor 重建與跨程序重播。claim callback 的 timeout／error 無法證明 ledger 未寫入，因此 reservation 不釋放；claim 後只有能證明 `stableSurface.click()` 尚未被呼叫的 pre-click failure 可釋放 process reservation，而且 ledger claim 仍禁止重新 claim或自動重送。click 一旦被呼叫，即使 stale／timeout／exception 也維持封鎖直到 fresh reconciliation。send module 不 import bridge；contract-only host probe 不能替代 genuine Chrome provenance、authenticated canary 或 stable node/frame mapping，也不接受 caller verifier、不公開 stable-backend mint，正式 live prepare／submit／finish／reconcile 分別固定在任何 DOM mutation、claim、click、receipt commit 前 fail closed。
5. trusted Chrome host integration 完成後，才可重新完整展開並讀取該留言串，用 fused `inspectAndFinish()` 在同一私有閉包建立並提交 post-submit receipt。現在正式 live method 全部固定 unavailable；下列內容是不可放寬的未來介面契約，不代表能力已啟用。只有 exact-own baseline 原本為 0、現在於正確父層恰好出現一份完全相同文字、送後總回覆數至少為送出前基線＋1，而且所有 reply item 都可檢查，所有驗證旗標才可為 `true`；receipt 也必須沿用 preparation／claim／preflight。`claimSubmit` 不公開任何接受 raw receipt 的 finish method：

   ```js
   const { receipt: result, commit: finishCommit } = await actuator.inspectAndFinish(
     tab, action, locatorPlan, attempt, preparation, options
   );
   ```

   - 確認送出且完整驗證：`sent_verified`
   - 明確沒有執行送出、已不可能送出，而且畫面沒有 exact／own 成功證據：`failed`
   - 其餘狀況一律：`needs_reconcile`，立即停止整批且不得重送

6. 下一次先重新讀畫面，建立 `chrome-comment-adapter.md` 定義的 fresh reinspection receipt，再對帳：

   ```js
   const { receipt: reinspection, commit: reconcileCommit } =
     await actuator.reinspectAndReconcile(
     tab, action, locatorPlan, attempt, attemptSessionId,
     currentSessionId, preparation, options
   );
   ```

   找到 own-account exact reply且目前總回覆數至少為送出前基線＋1，才能記 `reconciled_sent`；取得 versioned terminal exhaustion、沒有任何 own-author reply，而且 terminal count 等於可檢查 collection 且未低於基線時，才能記 `reconciled_not_sent`。沒有 terminal cursor／traversal、只讀到初始空 viewport、後頁才出現內容或 virtualization 造成 coverage 缺口時，reinspect 直接 fail closed，不得鑄造 absence receipt。文字被平台正規化、回覆總數倒退或其他不確定情況會追加 `browser_reinspection_observed`、消耗舊 capability 並輪替一份新的 capability，狀態仍是 `needs_reconcile`，不得重送。`browser-finish`／`browser-reconcile` 的 live CLI 只接受 fused actuator 私有閉包以 shell:false 經 stdin 傳入的 `{provenance, receipt}`；`claimSubmit.finishReceipt`／`reconcileReceipt` 不存在，raw receipt JSON、偽 nonce、重播、錯 action/session/scope 在 append 前拒絕。raw `begin-send`／`finish-send`／`reconcile` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕。

   若 Node／Chrome 程序在 `send_started` 或 `needs_reconcile` 後重啟，或 receipt capability 已過期，未來 production 只能呼叫 actuator 的 fused `recoverAndReconcile(...)`，並傳入新的 current session 與 `browser_process_restarted`／`receipt_capability_expired`；在 genuine Chrome host provenance、authenticated canary 與 stable frame/node mapping 完成前，此 method 也固定 unavailable。契約會在私有 Node bridge 內執行 recovery ceremony、吞入一次性 bearer，接著由同一閉包的 `reinspectAndReconcile` 建立並提交 fresh inspection；只回傳 outcome／digest 摘要，不回傳 receipt 或 nonce。底層 `browser-recover-reconcile` CLI 只是 shell:false bridge／隔離測試 boundary，不是操作入口，不得手動呼叫、保存 stdout 或把 capability 傳給 caller。此流程會把原 send attempt 原封不動地轉成／維持 `needs_reconcile`；不會回到 `approved`、不會輸出 `SUBMIT_CLAIM`，也不能再執行 `browser-action`／`browser-begin`。同一 recovery session、錯 session／scope／attempt 或已消耗 capability 都會在 ledger append 前拒絕。

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

Fixture 驗證入口包含 `node scripts/comment_chrome_actuator_test.mjs` 與 `node scripts/comment_chrome_scan_adapters_test.mjs`；前者另測 reply thread 的初始空 viewport、無 terminal cursor、later-page exact own reply／expander、virtualization、pre-claim 零 claim／零 submit click、recovery 無 absence receipt，以及 same-fingerprint DOM replacement 零點擊；後者專測 production/fixture scan authority 隔離、cursor／terminal exhaustion、virtualization、遲到控制與 same-fingerprint replacement 零點擊。真瀏覽器只可在 controlled Browser session 匯入 `comment_fixture_browser_e2e.mjs` 並呼叫固定三平台 `runAllFixtureBrowserE2E(tab)`；直接執行 `node scripts/comment_fixture_browser_e2e.mjs` 必須以 `NOT_RUN` 非零退出，避免把未開瀏覽器的 module load 當成 PASS。runner 先以 `typeof process` 相容受控環境，再只在 standalone Node 讀 `process.argv` 做 direct-main 判斷；暫存檔名完全使用不可預測 UUID，不依賴 process PID。runner 自有 ephemeral loopback server、固定 `facebook → instagram → threads`、直接使用 send core 與 in-memory test claim，並在 `finally` 驗證 active state、policy 與 source bytes 未漂移。不得提供外部 localhost、平台 subset、自訂順序或 actuator／CLI write bridge。

這個 runner 的 private raw receipt 與 detached SHA-256 sidecar 固定寫入 `.rd/receipts/three-platform-browser-fixture.json*`，只可標記為 `localhost_test_only_candidate`。raw receipt writer 不對外 export；只有固定 runner 完成三平台後，才能在持有合作式 Social Post writer 共用的 `data/.write.lock`、完成 stage 與發布前後 protected-state 重驗的同一流程內落盤。half-publish、readback 或 cleanup 失敗時必須恢復發布前已驗證的舊 receipt pair；恢復失敗則刪除整對檔案並 fail closed。接著執行 `python scripts/comment_fixture_promotion_envelope.py --write`：它會以 authoritative JS raw parser、detached SHA、fresh source／policy／architecture receipt 重驗 raw evidence，再寫出 canonical `.rd/receipts/three-platform-browser-fixture-promotion.json`。envelope 只可交給 `promotion=false` fixture verifier，固定保留 `trusted_host_verified=false`、`stable_node_frame_mapping_verified=false` 與 `live_browser_actuation_enabled=false`；它不能安裝 Chrome authority 或開啟任何 live successor。`data/.write.lock` 不承諾序列化未採用同一鎖協議的外部程式，crash 留下的 stale lock 也只可經人工核對後復原。fixture closure 的 Node import 與 global 權限採逐模組 exact allowlist，E2E runner 只允許 `typeof process` 存在性 guard 與 direct-main fail-closed 判斷所需的 `process.argv`；`process.pid`、`process.binding` 等額外 Node 權限一律阻擋。即使 contract 全綠，在尚未由受控 Browser 實跑前，`THREE_PLATFORM_BROWSER_FIXTURE` 仍是 `unmeasured`；實跑後也只證明 source-bound fixture 行為，不證明登入 Meta、trusted Chrome host、stable node/frame mapping 或 live send。任何 fixture 都不能打開 `live_browser_actuation_enabled`、修改 capability ledger 或取代使用者授權 canary。

每次改動 `comment_chrome_*.mjs`、`comment_js_architecture_*.mjs`、fixture E2E 或 fixture runtime，另執行：

```powershell
node scripts/comment_js_architecture_gate.mjs --self-test
node scripts/comment_js_architecture_gate.mjs --output .rd/receipts/js-architecture-gate.json
```

兩次 child exit、JSON `status=PASS` 與精確 success marker 都由 `comment_self_test.py` 驗證；Node 不存在時是 `NOT_CHECKED`／阻擋，不可當 skipped PASS。完整政策與 receipt 欄位見 `chrome-comment-validation.md`。
`--output` 僅可寫入 immediate `.rd/receipts/*.json`；traversal、source 覆寫、symlink／junction parent、symlink receipt 或 symlink `.sha256` sidecar 都必須被 gate 拒絕。actual receipt 與 detached SHA-256 sidecar 由 `comment_self_test.py` 共同驗證。
