# Chrome Comment Adapter Protocol

> last_verified: 2026-08-28
> scope: Codex 透過已登入的 Google Chrome，將可見 FB／IG／Threads 留言與本地 comment ledger 接起來。

這份文件只在 P5 實際掃描或回覆時讀。Chrome 是 UI actuator；`comment_assistant.py` 是 scope、授權與稽核的 source of truth。`scripts/comment_chrome_actuator.mjs` 是薄 facade，scan、send 與 durable claim bridge 分別在 `comment_chrome_scan.mjs`、`comment_chrome_send.mjs`、`comment_chrome_claim_bridge.mjs`。兩邊只交換版本化 JSON action／receipt，不讓瀏覽器自己決定回覆內容、授權或重試。

## 目錄

- Bridge 邊界與完整生命週期
- 可執行 actuator 與 Live DOM 定位原則
- Scan receipt
- Action 與送出前 preflight
- 單次送出與 post-submit receipt
- 不確定結果對帳
- 三平台差異

## 能力形狀

```text
live Chrome read
  ← stored browser-scan-request scope
  → browser-scan receipt
  → ledger / draft / approval
  → browser-action envelope
  → live preflight + composer fill
  → durable browser-begin claim
  → exactly one submit action
  → live reinspection
  → browser-finish receipt
```

Python 不能直接 import Codex 的 Chrome 工具，因此 bridge 不是背景 daemon。使用者啟動 P5 後，由當前 Codex Node session 持有 Chrome tab 與 actuator，逐步交換 JSON。`comment_chrome_claim_bridge.mjs` 以 `spawn` 參數陣列和 stdin 呼叫本機 ledger CLI，`shell:false`，不碰 Cookie、profile 或 Meta API。

正式 policy 另有 `live_browser_actuation_enabled=false` 的 default-deny gate。它不阻擋 read-only preparation、safe preview 或 action envelope，但會在任何 canonical ledger mutation 前拒絕 live `browser-scan／begin／finish／reconcile --write`。因此正式 Python claim 失敗時 actuator 必須在 click 前停止；contract fixture 只能在自己的 temp policy 顯式 opt-in，不能把這項測試證據冒充登入 Meta 的 live canary。

## 可執行 actuator

在持有 Browser／Chrome `tab` 的 persistent Node session 動態 import：

```js
const { createCommentChromeActuator } = await import(
  "file:///absolute/path/to/scripts/comment_chrome_actuator.mjs"
);
const preflightActor = createCommentChromeActuator();
const preparation = await preflightActor.prepareReply(
  tab, action, locatorPlan, options
);
const { createPythonLedgerClaimSubmit } = await import(
  "file:///absolute/path/to/scripts/comment_chrome_claim_bridge.mjs"
);
const claimSubmit = createPythonLedgerClaimSubmit({ preparation });
const actuator = createCommentChromeActuator({ claimSubmit });
```

公開介面只有五個：

- `scanPost(tab, scanRequest, scanPlan, options)`：從 live DOM 產生 authenticated scan receipt。
- `prepareReply(tab, action, locatorPlan, options)`：核對 context、空 composer、填入 immutable reply 並讀回，產生 preflight。
- `submitOnce(tab, action, locatorPlan, preparation, options)`：內部向 durable ledger 原子 claim；只有結構化、逐欄綁定的 `SUBMIT_CLAIM` 才點擊一次。
- `inspectResult(tab, action, locatorPlan, attempt, preparation, options)`：以 claim／preflight／preparation 綁定，檢查正確 parent 下恰好一份新出現的 own-account exact reply。
- `reinspect(...)`：為 `needs_reconcile` 產生存在／明確不存在／仍不確定的 fresh receipt。

actuator 不呼叫 ledger、不分類風險、不產生回覆、不建立 permit，也不能把不確定結果改成 sent。

## 連線與 tab

1. 依 `chrome:control-chrome` 選取 Google Chrome，完整讀取該 browser 的 runtime documentation。
2. 使用指定貼文 permalink；不要從首頁猜貼文。
3. 沿用同一 browser binding。tab 遺失時只重新取得 tab，不重新初始化整個 browser runtime。
4. 遇登入、2FA、CAPTCHA、checkpoint、限制訊息或錯誤 banner，停止，不建立 authenticated scan。

## 畫面定位原則

- 先讀 `tab.playwright.domSnapshot()` 或 live accessibility state，再建立當下 locator。
- body、作者、回覆按鈕與父層級必須在同一個可見留言容器內核對。
- 先用 comment permalink／平台 comment ID；沒有強 anchor 時可用作者＋完整本文，但只能得到 weak identity。
- locator 必須唯一、可見、enabled。count 不是 1 就停止，不猜第一個。
- 不保存長期 CSS selector；Meta A/B 或介面改版時重新讀當下 DOM。
- 不用 JavaScript 修改 DOM 來製造成功證據；evaluate 只做 read-only inspection。

Locator plan 每個 spec 至少包含 `selector`，可加 `within: "page" | "target" | "reply"`、`attribute`、`valueProperty` 或 `self`。`expected` 一律禁止；預期值只能來自核准 action／scan request。target anchor、作者、本文、reply trigger、composer、submit、reply items 與 expansion controls 都必須收斂在同一 target；reply author/body 再收斂到單一 reply item。count 不是 1、控制不在正確父層、回覆未全展開或有不可檢查項目都 fail closed。plan 是當輪 DOM 的短命資料，不寫進私人或公開 ledger。

## 1. Browser scan

先由 ledger 建立 request，Chrome 不得從當前頁面反向決定 scope：

```powershell
python scripts/comment_assistant.py browser-scan-request --platform instagram `
  --account-key <account> --post-key <post> --post-permalink <permalink> `
  --session-id <current-session> --ttl-minutes 10 --write
```

Chrome 依 request 完整展開指定貼文目前要處理的留言與回覆串後，從 fresh scan plan 呼叫 `scanPost()` 建立：

```json
{
  "schema_version": 1,
  "test_only": false,
  "scan_request_id": "stored-request-id",
  "session_id": "current-session",
  "platform": "instagram",
  "account_key": "expected-account",
  "post_key": "platform-post-id",
  "post_permalink": "https://www.instagram.com/p/example",
  "observed_url": "https://www.instagram.com/p/example",
  "observed_at": "2026-08-28T12:00:00+00:00",
  "authentication_state": "authenticated",
  "account_verified": true,
  "post_verified": true,
  "comments": [
    {
      "platform_comment_id": "visible-stable-id",
      "comment_permalink": "https://www.instagram.com/p/example/c/id",
      "observed_parent_post_permalink": "https://www.instagram.com/p/example",
      "author_key": "viewer-handle",
      "author_display": "Visible name",
      "body": "完整可見留言",
      "body_complete": true,
      "is_own": false,
      "has_own_reply": false,
      "language": "zh-Hant"
    }
  ]
}
```

三個 boolean 必須來自可見證據，不能用字串 `"true"`。每則 `observed_parent_post_permalink` 必須從該留言容器的 DOM 讀取，不得抄 request；自己的既有回覆必須以可見 own-author 證據確認。本文截斷、只剩翻譯、回覆串未展開或無法完整核對時，對應欄位用 `false`。`test_only:true` fixture receipt 永遠不能進 live ledger。

```powershell
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session>
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session> --write
```

live P5 不用 raw `ingest`；`browser-scan` 會以 append-only request 驗證 session、期限、登入狀態、平台 host、帳號／貼文 scope、每則留言 observed parent、scan 上限與 comment boolean，並追加可證明零結果的 completion event。若提供 comment permalink，其 path 必須是核准貼文 path 本身或子路徑，並保留貼文 query；它仍須和已核對的 parent post 一起出現。

## 2. 取得 immutable action

草擬與核准完成後：

```powershell
python scripts/comment_assistant.py browser-action `
  --intent-id <intent> --session-id <current-session>
```

輸出會綁定 permit、scope、留言 anchor、完整本文、fingerprint、最終單行 reply 與 reply hash。Chrome 只能輸入這份 `reply_text`，不得在畫面臨時改字。

## 3. Live preflight

回到 `post_permalink`，重新核對：

- 當前登入身分與 action account。
- 正確貼文與父留言層級。
- body 與 author；anchor／fingerprint 未改。
- reply control 唯一、可見、enabled。
- composer 原本為空。

`prepareReply()` 會先確認 composer 為空，再用 locator `fill()` 輸入單行 reply，以 read-only element value 重新讀回並確認與 action 的文字完全相同；不要把 Enter 當成換行。建立 fresh preflight：

```json
{
  "schema_version": 1,
  "test_only": false,
  "action_id": "immutable-browser-action-id",
  "intent_id": "reply-intent-id",
  "session_id": "current-session",
  "permit_id": "one-shot-permit",
  "scope": {
    "platform": "instagram",
    "account_key": "expected-account",
    "post_key": "platform-post-id",
    "comment_key": "canonical-comment-key"
  },
  "comment_fingerprint": "fingerprint-id",
  "reply_hash": "sha256-from-action",
  "action_digest": "sha256-of-canonical-action",
  "plan_digest": "sha256-of-fresh-locator-plan",
  "preparation_id": "sha256-of-preparation-core",
  "observed_url": "https://www.instagram.com/p/example",
  "observed_at": "2026-08-28T12:00:15+00:00",
  "baseline_exact_reply_count": 0,
  "baseline_total_reply_count": 3,
  "account_verified": true,
  "post_verified": true,
  "target_verified": true,
  "body_complete": true,
  "composer_empty_before_fill": true,
  "composer_matches_reply": true,
  "reply_control_verified": true,
  "evidence": "exact target and empty composer verified in live Chrome"
}
```

preflight 預設 60 秒失效，而且時間必須在 approval 之後、permit 到期之前。actuator 會重算 reply hash、action digest、plan digest 與 preparation ID；ledger 會再重算 action digest／preparation ID並要求 exact-own baseline 為 0。任何 flag 不是 boolean `true`，或綁定值不一致都拒絕。

```powershell
python scripts/comment_assistant.py browser-begin <preflight.json> `
  --intent-id <intent> --session-id <current-session> --write
```

`browser-begin --write` 只有在 append-only ledger 原子寫入 `send_started` 後，才輸出唯一一行 `SUBMIT_CLAIM {...}`。claim 逐欄綁定 action、permit、reply hash、action digest、plan digest、preparation ID 與新 preflight ID。live P5 不用 raw `begin-send`，也不接受可重播的裸字串 `WRITE_OK`。

## 4. Exactly one submit

- Facebook：Enter 可能直接送出；只在 `browser-begin` 成功後按一次。
- Instagram：使用當下唯一可辨識的 Post／發布控制或單次 Enter。
- Threads：reply 本身是一則 thread；確認父 thread 後只送一次。
- 點擊後不論 spinner、timeout、navigation 或 tab disconnect，都不得再點第二次。
- `submitOnce()` 在第一個 `await` 前先做 process-wide reservation，再呼叫 durable `claimSubmit`。同程序併發、重建 actuator，以及跨程序重播都必須被 in-process reservation 或 ledger 狀態拒絕。
- claim 後若 DOM、composer、action 或 plan 有任何漂移，只回報 pre-click failure，不退回 claim、不重試。

## 5. Post-submit receipt

重新檢查正確父層級。只有六項全為 boolean `true` 才算 sent：

```json
{
  "schema_version": 1,
  "test_only": false,
  "action_id": "immutable-browser-action-id",
  "preflight_id": "accepted-browser-preflight-id",
  "preparation_id": "accepted-preparation-id",
  "claim_id": "durable-submit-claim-id",
  "intent_id": "reply-intent-id",
  "session_id": "current-session",
  "scope": {
    "platform": "instagram",
    "account_key": "expected-account",
    "post_key": "platform-post-id",
    "comment_key": "canonical-comment-key"
  },
  "comment_fingerprint": "fingerprint-id",
  "reply_hash": "sha256-from-action",
  "observed_url": "https://www.instagram.com/p/example",
  "observed_at": "2026-08-28T12:00:30+00:00",
  "submission_attempted": true,
  "submission_possible": true,
  "account_verified": true,
  "post_verified": true,
  "target_verified": true,
  "parent_verified": true,
  "exact_reply_visible": true,
  "own_author_verified": true,
  "post_submit_total_reply_count": 4,
  "evidence": "exact own-account reply visible under target comment"
}
```

```powershell
python scripts/comment_assistant.py browser-finish <result.json> `
  --intent-id <intent> --session-id <current-session> --write
```

- `send_started` 會保存送出前的總回覆基線；sent 除了所有旗標成立，送後總回覆數還必須至少為「基線＋1」。若 exact reply 出現但總數沒有增加，因果仍不明，只能記 `needs_reconcile`。
- submit 已發生但任何驗證 flag 不成立：自動記 `needs_reconcile`，停止整批。
- 明確沒有執行送出、已不可能送出，而且 exact reply／own author 兩項都為 `false`：可記 `failed`；任何矛盾成功證據都改為 `needs_reconcile`。
- receipt action／preflight／preparation／claim、scope、hash、fingerprint、session 不符或超過 300 秒：拒絕寫入；因可能送錯位置，停止人工檢查。

live P5 不用 raw `finish-send --evidence`。raw `begin-send`／`finish-send` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕。

同 session、同 platform／account／post 只要有另一個 active `needs_reconcile`，domain 會拒絕新的 action 與 preflight。這是 run-level circuit breaker，不依靠 operator 記得停止。

## 6. Reinspection

`needs_reconcile` 下一次先重新載入指定 permalink，搜尋相同 own account＋完全相同 reply＋正確 parent：

- 建立 fresh reinspection receipt，沿用原 action ID、preflight ID、preparation ID、claim ID、scope、fingerprint 與 reply hash；另帶原 `attempt_session_id`、當前 session、observed URL／時間、四項 context flags，以及 `exact_reply_visible`、`own_author_verified`、`absence_verified`、`own_author_reply_count`、`reinspection_total_reply_count`。
- 找到 own-account exact reply，而且目前總回覆數至少為「送出前基線＋1」：`browser-reconcile` 才能寫入 `reconciled_sent`。
- 完整展開且明確確認不存在：只有完全沒有任何 own-author reply，而且目前總回覆數沒有低於送出前基線時，`browser-reconcile` 才能寫入 `reconciled_not_sent`，之後才可重新草擬／核准取得新 permit。若存在 own-author 但文字被平台正規化或與核准文字不完全相同，或目前可見總數低於基線，仍保持不確定，禁止重送。
- 仍不確定：`browser-reconcile` 回 `NO_CHANGE`，保持原狀，不重送。

```json
{
  "schema_version": 1,
  "test_only": false,
  "action_id": "immutable-browser-action-id",
  "preflight_id": "accepted-browser-preflight-id",
  "preparation_id": "accepted-preparation-id",
  "claim_id": "durable-submit-claim-id",
  "intent_id": "reply-intent-id",
  "session_id": "current-reinspection-session",
  "attempt_session_id": "original-send-session",
  "scope": {
    "platform": "instagram",
    "account_key": "expected-account",
    "post_key": "platform-post-id",
    "comment_key": "canonical-comment-key"
  },
  "comment_fingerprint": "fingerprint-id",
  "reply_hash": "sha256-from-action",
  "observed_url": "https://www.instagram.com/p/example",
  "observed_at": "2026-08-28T12:05:00+00:00",
  "account_verified": true,
  "post_verified": true,
  "target_verified": true,
  "parent_verified": true,
  "exact_reply_visible": true,
  "own_author_verified": true,
  "absence_verified": false,
  "own_author_reply_count": 1,
  "reinspection_total_reply_count": 4,
  "evidence": "exact own-account reply found after reload"
}
```

```powershell
python scripts/comment_assistant.py browser-reconcile <reinspection.json> `
  --intent-id <intent> --session-id <current-session> --write
```

raw `reconcile` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕。

## 平台差異

| 平台 | 強 anchor | 送出後必要證據 |
|---|---|---|
| Facebook | comment permalink／comment ID | 同一留言下的 own-account exact text |
| Instagram | IG comment permalink／stable ID | 正確 post 的展開回覆串內 exact text |
| Threads | reply permalink／post ID | 正確 parent thread 下的新 reply permalink 或 exact text |

平台 adapter 只解讀與操作 live UI；它不能建立 permit、放寬政策、把 unknown 改 sent 或自行重試。

## 驗證層級

- `node scripts/comment_chrome_actuator_test.mjs`：純 Node fail-closed、parent binding、零基線、併發與 actor recreation regression。
- `node scripts/comment_chrome_claim_bridge_test.mjs`：durable claim 的 live/test 邊界與逐欄 binding。
- `node scripts/comment_chrome_claim_integration_test.mjs`：兩個獨立 Python 程序競逐同一 durable claim，驗證只允許一個成功並只追加一筆 `send_started`。
- `comment_fixture_browser_e2e.mjs`：需 Browser Plugin backend，對三個 localhost 互動 fixture 實測 DOM/fill/click/reinspect；只允許 loopback `testOnly` URL 映射。
- 真實 FB／IG／Threads：仍需已登入 Chrome、當前 UI 的 fresh locator plan 與使用者授權 canary；fixture 綠燈不能替代 live canary。
