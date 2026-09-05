# Chrome Comment Adapter Protocol

> last_verified: 2026-09-05
> scope: Codex 透過已登入的 Google Chrome，將可見 FB／IG／Threads 留言與本地 comment ledger 接起來。

這份文件只在 P5 實際掃描或回覆時讀。Chrome 是 UI actuator；`comment_assistant.py` 是 scope、授權與稽核的 source of truth。`scripts/comment_chrome_actuator.mjs` 是薄 facade，scan、versioned platform adapter、read-only host/document contract、send 與 durable claim bridge 分別在 `comment_chrome_scan.mjs`、`comment_chrome_scan_adapters.mjs`、`comment_chrome_host_authority.mjs`、`comment_chrome_send.mjs`、`comment_chrome_claim_bridge.mjs`。兩邊只交換版本化 JSON action／receipt，不讓瀏覽器自己決定回覆內容、授權或重試。

## 目錄

- Bridge 邊界與完整生命週期
- 可執行 actuator 與 Live DOM 定位原則
- [連線、重連與來源 tab 生命週期](chrome-comment-runtime.md)
- Scan receipt
- Action 與送出前 preflight
- 單次送出與 post-submit receipt
- 不確定結果對帳
- 三平台差異
- [驗證層級與 live canary boundary](chrome-comment-validation.md)

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

掃描與送出有獨立開關：`live_browser_scan_enabled=true` 允許已核准 scope 的來源綁定回填；`live_browser_actuation_enabled=false` 仍關閉泛用 production 送出。獨立 canonical canary lease 綁定當前 session、已核准 action、reply hash、exact scope 與 source digest，最長 300 秒、只可消耗一次；不修改 production policy 或 capability projection。當前 CUA 送出只接 Threads 單則候選，IG 的一次送出／對帳屬舊 SDK 歷史實證。claim 失敗必須在 click 前停止，測試通過或 lease 存在都不代表真實送出成功。

## 當前實作狀態（不是完成宣告）

目前 CUA 工具不暴露舊 `dom_cua` 或 Node REPL browser factory；新路徑依
`chrome-comment-runtime.md` 一次性 bootstrap，沿用本 bridge 的 ledger／claim／對帳。
Threads 已加入 source-selected 空 modal preparation 與 native own-child 正向 reader；
2026-09-05 已實際送出一次並取得原生 own-child 正向觀測；canonical ledger 尚為
`needs_reconcile`。exact-tab recovery 來源修正已通過 focused tests，但當前 Chrome 控制連線
在原生檢查前回報 `Debugger unattached`；未新增 recovery／rotation 事件。真實唯讀結算
仍待連線恢復，不重送，也不能先宣稱 `reconciled_sent` 或已完成 live exact-tab recovery。
CUA 採 fresh 語義 selection
與單次 locator click，不冒充舊 fixture 的持久 node ID 契約；此差異不解鎖泛用能力。

Native target 目前 IG、Facebook、Threads 均已完成真實指定留言回填。Facebook 已透過來源持有的 exact-tab reuse 雙讀帳號與完整本文，完成 canonical target-only observation；Threads 以原生 context pagelet 核對父貼文與焦點留言，不再以任意列順序代替層級。指定留言回填不代表送出／整串完整性已驗證。

- `scanAndCommit(tab, target, locatorPlan, options)`：來源綁定的 Chrome 掃描與私有帳本回填；正式模式由受信任 host 取得證據，不接受 caller 自行捏造的 receipt。參數型態以 bridge 實作為準。
- `observeTargetComment({ platform, account_key, post_key, post_permalink, platform_comment_id, comment_permalink, session_id, ttl_minutes? })`：fused 只讀入口，具備 IG／Facebook／Threads 原生 reader。先建立 target-only request，再於來源持有的 tab 雙讀完整作者／本文／原生 anchor，以私有 bearer 回填 canonical observation；不接收 caller 的 tab、body、author、receipt 或 resolver。各平台的實證範圍依本節分開記錄。
- `executeCanaryReply({ intentId, sessionId, leaseId })`：限已核准 action 與有效 lease 的單則入口。當前 CUA Threads 路徑核對原生 explicit-zero marker、兩次穩定讀取、來源點選空 modal、actor 及完整核准文字；durable claim 後最多點擊一次，再查證正確父層的新 native own child。無 lease、自訂 callback、source drift、過期或證據不足皆停止。舊 SDK 的 IG 路徑使用正數回覆展開、零既有 own reply 與原生 mention selection；2026-08-31 已送出一次，未知後經新 session 唯讀 recovery 結算 `sent`，全程未重送。IG 歷史案例不代表當前 CUA 支援 IG，Threads 當輪進度以上述未結算狀態為準；兩者均非三平台／批次驗證。
- `executeApprovedReply({ intentId, sessionId })`：新增候選 fused 路徑。只讀取本機已核准 action，私有 tab 驗證原留言、編輯器、完整本文與穩定節點，durable claim 後最多點擊一次，再由私有 bridge 提交結果。預設開關仍關閉。
- `recoverApprovedReply({ intentId, sessionId, reason? })`／`reconcileUncertainReply({ intentId, sessionId })`：只重新查看，不 fill、不 submit claim、不 submit。唯讀 `browser-recovery-action` 核對原 attempt／action digest／scope，不能把 uncertain 變回 approved。同程序 unknown 保留私有原 attempt 與現有 capability；只有合法 receipt commit 或明確 recovery 才輪替 authority。正向 reader 未能建立 receipt context 時回傳 `committed:false`、`reconcile_required:true`，不提交偽造 flags／零數量 receipt。真正重啟後用不同 recovery session 接回，不能偽稱重啟。已消耗 canary 即使 lease 到期仍可唯讀結算，不會重新取得送出權。
- Threads 已完成指定樣本的帳號、原貼文、原留言、完整本文與私人帳本雙讀回填。reader 綁定原生 context、精確焦點網址、標題及時間連結；子回覆頁可能有多層 ancestor，必須核對原留言是 immediate parent，不能用任意列順序替代。截斷、載入中、錯作者／父層一律拒絕。原生「尚無回覆」與窄化 terminal reader 只提供單則 canary baseline，不升級泛用 complete／absence。當前 CUA 已送出一次並取得 own-child 正向觀測；帳本尚為 `needs_reconcile`，不允許再送一次來補證據。
- FB 已於 2026-08-31 經 `observeTargetComment` 完成指定原生留言的來源綁定回填：重用唯一 exact permalink tab，不 reload、不關閉，雙讀登入帳號、作者與完整本文，再提交 canonical target-only observation。正式 reader 已接入 `comment_chrome_facebook_child_reader.mjs`，並在同一授權貼文的既有自己回覆通過唯讀實測：精確核對原生父／子 ID、作者、完整本文及表情符號；不是本輪新送出的留言。原生 tracking query 與可見 mention wrapper 有窄化解析，但缺隱藏文字、錯父／作者、URL 漂移仍拒絕。回傳永遠明示 `complete=false`、`absence_verified=false`；未找到不代表不存在，正向讀取也不鑄造 receipt／送出權。完整展開與 composer actor 尚未驗證，`whole_post_complete=false`、`reply_thread_complete=false`，尚無 FB 真實送出。story／permalink query 解析保留並核對 `story_fbid`＋`id`，不能因未解析出留言就宣稱完整零結果。
- IG 已在使用者指定樣本完成 native comment page 的 account／parent／whole-body／child-permalink／composer 只讀正反驗證。`p/reel/reels/tv` 僅在同 host、shortcode 與 query 時視為同貼文；原生留言 `/p/S/c/P/` 與子回覆 `/p/S/c/P/r/R/` 分別綁定層級。未展開的回覆不能當零；shared textarea 的 `@author` 自動帶入不能單獨證明選中了正確父留言。泛用 surface 仍 `complete=false`；單則驗證只可走獨立 canary 入口，不能推導 absence 或整篇掃描完成。
- 舊 SDK IG native canary 先確認尚未選取的 editor 為空；點選指定父留言後，原生 `@author ` 前綴必須與核准 reply 完全相容並保留。preflight 如實記為 `composer_empty_before_fill=false`、`composer_initial_state=native_target_mention`，另綁來源持有的 selection evidence，不偽稱原生帶入後仍是空框。當前 CUA Threads 使用來源點選的真正空 modal，核對 Lexical 空結構後才填入，記為 `composer_empty_before_fill=true`。`document_binding.kind=source_owned_ui_continuity` 只綁來源 tab、exact URL、帳號與完整作者／本文摘要，不保證同 URL reload 偵測、實體 document epoch 或持久 node identity，也不升級完整 lifecycle／absence authority。
- IG Reel 畫面可能同時顯示 Facebook 留言數；分平台只認該平台原生留言 anchor，不以合併總數或已載入 viewport 當完整掃描。不同語言依原文草擬；索取集數、語言版或連結都需人工確認，不自動承諾未存在的內容。
- 不用未指定貼文、動態牆、私訊或整頁私人截圖補齊缺證據。缺少指定樣本或公開測試授權時停止 live 驗證，報告具體缺口；不要重跑同一批 tests 當成進度。

以下分離式 `prepareReply`／`submitOnce` 舊介面仍是 fixture／未來契約；不得把它與上方候選 fused 入口混為一談。canary 正向確認必須查證正確 immediate parent、own account 與完整核准文字，且原生總回覆數至少為原基線＋1；IG 路徑另核對原有 reply rows。CUA Threads 會開啟當下觀測到的 own-child permalink 並核對其原生父層，再返回原留言重新查證。timeout、看不到新 child、內容／層級不符皆保留 unknown／`needs_reconcile`，停止且不再 click。候選入口與單則結果都不能自行升級公開 capability projection。

## 可執行 actuator

當前 CUA 依 [runtime bootstrap](chrome-comment-runtime.md#當前-cua-工具路徑) 呼叫 `createCommentCuaActuator(cua, { browserId })`，只使用回傳的 fused actuator，不向 operation 傳入 tab／receipt／resolver。以下示例只說明 legacy／fixture 分離式介面，不是當前 CUA 的啟動方式：

```js
const { createCommentChromeActuator } = await import(
  "file:///absolute/path/to/scripts/comment_chrome_actuator.mjs"
);
const { createTrustedPlatformScanPlan } = await import(
  "file:///absolute/path/to/scripts/comment_chrome_scan_adapters.mjs"
);
// 正式 registry 不含 fixture factory，也不接受 tab、selector 或 caller
// resolver。source-wired read-only host/document contract 已存在，但仍需
// genuine Chrome provenance、已登入 canary 與 live locator revision；目前
// 三平台一律 fail closed，不能由這個 probe 鑄造 scan plan。
const scanPlan = createTrustedPlatformScanPlan("instagram");
// FUTURE LIVE CONTRACT ONLY. The current build rejects live preparation
// before any expansion, trigger click, composer fill, claim, or submit.
const preflightActor = createCommentChromeActuator();
const preparation = await preflightActor.prepareReply(
  tab, action, locatorPlan, options
);
const { createPythonLedgerClaimSubmit } = await import(
  "file:///absolute/path/to/scripts/comment_chrome_claim_bridge.mjs"
);
const claimSubmit = createPythonLedgerClaimSubmit({ preparation });
const actuator = createCommentChromeActuator({
  claimSubmit,
});
```

同一個 branded `claimSubmit` 只負責 durable claim；它不公開 `finishReceipt`、
`reconcileReceipt` 或任何接受 raw receipt 的 commit method。當前 fused 入口的正式收據
只能由 bridge 私有流程在 fresh DOM 檢查後提交；以下分離式
`inspectAndFinish()`／`reinspectAndReconcile()` 仍是 fixture／未來契約。
nonce 只留在 Node 記憶體，並以 `spawn(argv, {shell:false})` 透過 stdin 傳給 Python。
不要把 capability、nonce 或完整 provenance envelope 寫到檔案、文件、console 或
canonical ledger。

以下五個是分離式 fixture／未來 production 契約，不包含上方獨立候選 fused 入口：

- `scanPost(tab, scanRequest, scanPlan, options)`：從 live DOM 產生 authenticated scan receipt；目前 live registry 沒有可用 plan，因此正式路徑 fail closed。
- `prepareReply(tab, action, locatorPlan, options)`：未來 live 契約會核對 context、空 composer、填入 immutable reply 並讀回；目前只有 loopback `testOnly:true` fixture 可執行，live 在任何 DOM mutation 前 fail closed。
- `submitOnce(tab, action, locatorPlan, preparation, options)`：內部向 durable ledger 原子 claim；只有結構化、逐欄綁定的 `SUBMIT_CLAIM` 才點擊一次。
- `inspectAndFinish(tab, action, locatorPlan, attempt, preparation, options)`：以 claim／preflight／preparation 綁定，fresh 檢查後在同一私有閉包提交 finish；呼叫者拿不到可另行 commit 的 raw receipt API。
- `reinspectAndReconcile(...)`：為 `needs_reconcile` fresh 檢查存在／明確不存在／仍不確定，並在同一私有閉包提交 reconcile。

以上 live method 是 trusted-host integration 完成後的封閉介面契約；目前 `prepareReply()`／`submitOnce()`／`inspectAndFinish()`／`reinspectAndReconcile()`／`recoverAndReconcile()` 對 live 一律回報 unavailable。`prepareReply()` 會在 reply exhaustion、trigger click 與 composer fill 以前停止，不能把下方範例當作已啟用能力。

`inspectResult()`／`reinspect()` 只保留 `testOnly:true` fixture 診斷；live 呼叫會 fail closed。
直接 import `createSendOperations()` 即使能產生 frozen receipt，也沒有任何公開 commit
surface；自訂 runner、root 或 scriptPath 的 bridge 也不能使用 fused live commit。目前正式
policy 仍 default-off，泛用 production adapter 未完成對應 host／exhaustion／live locator
promotion，分離式正式路徑維持 fail closed；獨立單則 fused canary 不解鎖它。
actuator 不分類風險、不產生回覆、不建立 permit，也不能把不確定結果改成 sent；
候選 fused 入口只提交自己剛取得的 fresh evidence，不向 caller 開放 raw receipt commit。

## 連線與 tab

P5 建立或恢復 Chrome 連線、取得 tab，或辨識 Threads icon-only 控制前，必讀[連線與執行環境規則](chrome-comment-runtime.md)。該文件維護來源 binding、限定重連、exact-tab reuse 與只讀節點辨識的安全邊界；不能以重連或重新取得節點恢復送出權。

## 畫面定位原則

- 先讀當前工具文件化的 accessibility state（CUA 為 `tab.getAXState()`）或相應已支援的 DOM snapshot，再建立當下 locator；不假設舊 `domSnapshot()` 存在。
- body、作者、回覆按鈕與父層級必須在同一個可見留言容器內核對。
- 先用 comment permalink／平台 comment ID；沒有強 anchor 時可用作者＋完整本文，但只能得到 weak identity。
- locator 必須唯一、可見、enabled。count 不是 1 就停止，不猜第一個。
- 不保存長期 CSS selector；Meta A/B 或介面改版時重新讀當下 DOM。
- 不用 JavaScript 修改 DOM 來製造成功證據；當前 CUA evaluate 只做 inspection，不安裝 expando。舊 SDK／隔離 fixture 的 reply-exhaustion expando 契約只適用其已文件化且受測的節點路徑，不能帶入 CUA 或用來宣稱持久節點保證。

送出端 locator plan 每個 spec 至少包含 `selector`，可加 `within: "page" | "target" | "reply"`、`attribute`、`valueProperty` 或 `self`。`expected` 一律禁止；預期值只能來自核准 action。target anchor、作者、本文、reply trigger、composer、submit 與 reply items 都必須收斂在同一 target；reply author/body 再收斂到單一 reply item。

掃描端另有更窄的 trusted boundary：

- production module 不含 fixture selector／factory／註冊 hook。live scan 不接受 raw selector object、tab、caller resolver，也不接受 deep clone／JSON round-trip 後的 plan；只有 source 內建的 trusted host resolver 綁定 canary revision 後，`createTrustedPlatformScanPlan(platform, { adapterVersion })` 才能有可用結果。目前 factory 直接回 capability unavailable。
- `comment_chrome_host_authority.mjs` 已提供 contract-only 的 `probeTrustedPlatformHost()`：它透過固定 source import 取得 trusted Node REPL browser service，只從 fresh `openTabs()` 清單 claim 唯一且 URL 完全相符的原始 tab object，caller 不能傳入 duck-typed tab／agent／resolver。它核對 HTTPS exact host、平台 post permalink、前後 URL、單一 top-level `html` root、document epoch 與 main-frame-only policy；frame-aware snapshot 只要看見 iframe 就拒絕。attestation 以 process-local brand／keyed digest 防止 clone／跨 tab／換 scope／同 URL reload 重播；但在已登入真 Chrome permalink canary 與受信任 promotion receipt 尚未完成前，仍**不等於已驗證 Meta production provenance**，也不能鑄造 live scan plan、點擊或回覆。
- plan 同時綁定 `platform + adapterId + adapterVersion + schema version`，由 process-local `WeakSet` brand 驗真，且整棵 JSON deep-frozen；跨平台、舊版、竄改或複製物一律拒絕。
- `threadExpansionComplete` 是 caller claim，live／trusted plan 禁止提供。兩次空 viewport read 也不是 complete 證據。versioned exhaustion contract 必須記錄明確 cursor、monotonic discovered count、受控 viewport traversal 與 explicit terminal marker；沒有 terminal cursor、cursor 重播、count 倒退或未註冊 traversal 都是 partial／fail closed。
- adapter 只點自己版本中註冊的 comment／reply／viewport traversal controls；每個 fixture control 另綁 stable instance ID，click 前 instance 或 fingerprint 被相同外觀的新節點替換時零點擊。live 必須在 trusted host resolver 定義等價的 stable-node contract 後才能啟用。
- terminal 後仍要穩定雙讀 state、controls 與 traversal；attestation 綁 cursor sequence、discovered-count sequence、terminal cursor/count、fixed bounds 與 plan digest。terminal discovered count 必須等於最後可完整檢查的穩定 DOM collection；virtualized 後只剩最後一頁、遲到控制／留言或 coverage 不足一律拒絕。
- localhost controlled fixture 已移到獨立 `comment_chrome_scan_fixture_testonly.mjs`，由 `createTrustedFixtureScanPlan()`＋`createTrustedFixtureScanPost()` 產生；production import graph 不匯入 fixture factory。fixture 只允許 `testOnly:true`＋loopback，不能取得 live brand、不能寫入 active live ledger。raw test plan 只能測 partial locator 行為。

adapter 版本只是受控 DOM contract，不代表 Meta UI 永遠不變。fixture registry 與 production registry 位於不同模組，fixture 的 `[data-fb-*]／[data-ig-*]／[data-threads-*]` selector 永遠不能提升為 live。**目前三平台 production registry 均為 `unavailable_pending_authenticated_canary_and_live_locator_revision`**；read-only contract probe 的存在不會改變這個狀態。每次取得真實 selector 或更新 UI revision都要換版本，重跑 host negatives、exhaustion regression、三平台 fixture 與已登入 read-only canary；完成前維持 `live_browser_actuation_enabled=false`。

模組化維護邊界：UI 改版只調整授權範圍的平台 reader／selection／result 模組及相應回歸測試，沿用共用 ledger、permit、一次性 claim 與 receipt 契約。若是權限拒絕、登入挑戰、CAPTCHA、checkpoint 或平台限制，必須暫停；不能把它當成 selector 問題，以換 URL、runtime、帳號或重試繞過，也不承諾不中斷／24 小時運作。

## 1. Browser scan

指定留言不必假裝已掃完整篇：`observeTargetComment` 的私有 bridge 依序執行 `browser-target-observation-request` 與 `browser-target-observation`。request／action 明示 `observation_scope=target_comment` 與 exact native ID／permalink，bearer binding 同樣包含這份 scope；完成事件是 `browser_target_observation_completed`，固定一則且 `whole_post_complete=false`、`reply_thread_complete=false`，沒有 `zero_result`。provenance 只證明 target receipt continuity；`has_own_reply=false` 是未觀測到，不是 absence proof。原文語言未知用 `und`，草擬時再依完整原文判斷。以下整篇 scan 契約不得拿來替代或放大這份 target-only 證據。

先由 ledger 建立 request，Chrome 不得從當前頁面反向決定 scope：

```powershell
python scripts/comment_assistant.py browser-scan-request --platform instagram `
  --account-key <account> --post-key <post> --post-permalink <permalink> `
  --session-id <current-session> --ttl-minutes 10 --write
```

production adapter 經 authenticated canary 驗證後，Chrome 依 request 展開指定貼文目前要處理的留言與回覆串，再由 `scanPost()` 建立：

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
  ],
  "thread_expansion_evidence": {
    "provided": true,
    "comments_expanded": true,
    "replies_expanded": true,
    "evidence": "versioned adapter proved cursor traversal, monotonic discovered count, explicit terminal coverage, and stable re-verification",
    "adapter_attestation": {
      "schema_version": 1,
      "platform": "instagram",
      "adapter_id": "instagram-comments",
      "adapter_version": "2026-08-28.1",
      "plan_digest": "sha256-of-registered-plan",
      "total_clicks": 4,
      "exhaustion_schema_version": 1,
      "viewport_cursors": ["initial", "after-scroll", "terminal"],
      "discovered_count_sequence": [8, 14, 17],
      "monotonic_discovered_count": true,
      "terminal_evidence": true,
      "terminal_cursor": "terminal",
      "terminal_discovered_count": 17,
      "stable_read_count": 2,
      "terminal_control_count": 0,
      "attestation_id": "sha256-of-attestation-core"
    }
  }
}
```

三個 boolean 必須來自可見證據，不能用字串 `"true"`。每則 `observed_parent_post_permalink` 必須從該留言容器的 DOM 讀取，不得抄 request；自己的既有回覆必須以可見 own-author 證據確認。本文截斷、只剩翻譯、回覆串未展開或無法完整核對時，對應欄位用 `false`。live 的 complete expansion 只能來自上述 branded attestation，不能由呼叫者填 boolean；`test_only:true` fixture receipt 永遠不能進 live ledger。

```powershell
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session>
python scripts/comment_assistant.py browser-scan <scan.json> `
  --scan-request-id <request-id> --session-id <current-session> --write
```

live P5 不用 raw `ingest`；`browser-scan` 會以 append-only request 驗證 session、期限、登入狀態、平台 host、帳號／貼文 scope、每則留言 observed parent、scan 上限與 comment boolean，並追加可證明零結果的 completion event。comment permalink 必須符合該平台的原生 anchor 契約並綁定已核對的 parent post；Threads 原留言／子回覆可有獨立 post path，不能用任意同站網址或僅靠 path 前綴推定父層。

## 2. 取得 immutable action

草擬與核准完成後：

```powershell
python scripts/comment_assistant.py browser-action `
  --intent-id <intent> --session-id <current-session>
```

輸出會綁定 permit、scope、留言 anchor、完整本文、fingerprint、最終單行 reply 與 reply hash。Chrome 只能輸入這份 `reply_text`，不得在畫面臨時改字。

## 3. 未來的 Live preflight 契約（目前未啟用）

回到 `post_permalink`，重新核對：

- 當前登入身分與 action account。
- 正確貼文與父留言層級。
- body 與 author；anchor／fingerprint 未改。
- reply control 唯一、可見、enabled。
- composer 原本為空。

泛用 trusted-host integration 完成後，分離式 `prepareReply()` 才會先確認 composer 為空，再用 locator `fill()` 輸入單行 reply，以 read-only element value 重新讀回並確認與 action 的文字完全相同；不要把 Enter 當成換行。此分離式 live 呼叫在任何 DOM inspection／expansion／click／fill 之前固定拒絕；下文是 future receipt contract，不限制上方獨立 CUA Threads canary 的已實作 preparation。

在碰 reply trigger 以前，送出 plan 還必須提供 `replyExhaustion` schema version 1：target-scoped state 要同時給 cursor、monotonic discovered count 與 explicit terminal；非 terminal page 必須有唯一、受綁定的 viewport traversal control，所有 reply expander 也要有 stable instance 與 same-node binding。只有 terminal stable 雙讀、expander／traversal 都歸零，且 terminal discovered count 等於仍可逐筆檢查的 reply collection，baseline 才成立。`0` 個 reply item 或 `0` 個 expander 本身不是 absence／complete 證據；沒有 terminal cursor、沒有 traversal、count 倒退、virtualization 只留下後頁，或 lazy page 後來才出現 exact own reply，都在點 reply trigger 前停止。

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

preflight 預設 60 秒失效，而且時間必須在 approval 之後、permit 到期之前。actuator 會重算 reply hash、action digest、plan digest 與 preparation ID；ledger 會再重算 action digest／preparation ID並要求 exact-own baseline 為 0。泛用契約任何 flag 不是 boolean `true`，或綁定值不一致都拒絕。唯一獨立候選例外是有效 IG canary 的原生 mention editor：`composer_initial_state`、`composer_initial_text`、`selected_parent_evidence`、`selected_parent_evidence_digest` 四欄皆須納入 preparation digest，不能把 nonempty editor flag 改成 `true`。

```powershell
python scripts/comment_assistant.py browser-begin <preflight.json> `
  --intent-id <intent> --session-id <current-session> --write
```

`browser-begin --write` 只有在 append-only ledger 原子寫入 `send_started` 後，才輸出唯一一行 `SUBMIT_CLAIM {...}`。claim 逐欄綁定 action、permit、reply hash、action digest、plan digest、preparation ID 與新 preflight ID，並帶一份 version 1、短命且一次性的 finish bearer capability。ledger 只保存 nonce 的 domain-separated SHA-256、權威 action/session/scope binding digest、capability ID 與期限，不保存 nonce。live P5 不用 raw `begin-send`，也不接受可重播的裸字串 `WRITE_OK`。

## 4. Exactly one submit

以下分離式 `submitOnce`／stable-node 規則屬 legacy／fixture 與未啟用的泛用契約；當前 CUA Threads fused 入口按本節末尾的 semantic selection 路徑執行。這些平台 UI 說明不授權使用目前未支援的 FB／IG 送出方式。

- Facebook：Enter 可能直接送出；只在 `browser-begin` 成功後按一次。
- Instagram：使用當下唯一可辨識的 Post／發布控制或單次 Enter。
- Threads：reply 本身是一則 thread；確認父 thread 後只送一次。
- 點擊後不論 spinner、timeout、navigation 或 tab disconnect，都不得再點第二次。
- `submitOnce()` 在 durable `claimSubmit` 前建立 process-wide reservation；同程序併發、重建 actuator，以及跨程序重播都必須被 in-process reservation 或 ledger 狀態拒絕。claim callback timeout／error 可能發生在 ledger commit 前或後，無法證明時 reservation 必須保留。
- `submitOnce()` 會在消耗 durable claim 前再次執行整份 reply exhaustion contract，並確認 composer 仍完全等於 immutable action。此時沒有 terminal coverage、出現遲到 expander／page，或 later page 找到 exact own reply，都必須是 claim 次數 0、submit click 次數 0；claim 後仍再做一次相同檢查處理 TOCTOU。
- durable claim 已成功、但可證明 `stableSurface.click()` 尚未被呼叫的 DOM／composer／action／plan 漂移，只回報 pre-click failure並可釋放 process reservation；ledger claim 仍是權威狀態，不能重新 claim 或自動重送。只要 click 已被呼叫，包含 stale、timeout、navigation、disconnect 或任何 exception，都視為可能已寫入 UI，reservation 必須維持到 fresh reconciliation。
- `comment_chrome_send.mjs` 不反向 import claim bridge。泛用 stable-node 路徑的 host/document contract 已存在，但對應 authenticated canary 與 stable frame/node mapping 尚未完成；public low-level factory 不接受 caller verifier，也不公開 stable-backend mint。即使傳入 fake tab、fake verifier 或 fake backend，該分離式 live prepare／submit／finish／reconcile 都必須分別在 DOM mutation、claim、click 與 receipt commit 前 fail closed；不得把 CUA 單則實證當成這份泛用契約已完成。

legacy／隔離 fixture 的 stable-node 路徑不能把其最後一步換成 lazy locator `click()`：selector 可能重新解析到替代節點。該路徑使用 Browser `dom_cua` stable-node surface：從不可變 visible-DOM snapshot 取得全頁唯一的精確 submit identity 與字串 `node_id`，三次核對均須同一 ID，最後只呼叫一次 `dom_cua.click({node_id})`。舊節點 detached 時 stale-fail，禁止 fallback 或 retry；surface 缺失在 durable claim 前拒絕。泛用 live stable-node authority 尚未完成、也無 public mint；這不是當前 CUA Threads 的 transport，不能要求 CUA 使用不存在的 `dom_cua`。

legacy stable same-node binding 也不宣稱瀏覽器層完全原子：節點檢查後至 mouse event 仍有競態。當前 CUA Threads 則誠實採用較窄的 semantic UI continuity：最後 lease I/O 後重新核對來源 tab、exact parent、actor、modal、完整核准文字與唯一 enabled submit，再呼叫一次文件化 `locator.click()`。不安裝 expando、不宣稱 persistent node identity 或原子交易；未知／timeout 不 retry，process reservation 不釋放。click 回傳不是成功證據，必須依原生 own-child／immediate-parent 查證及有效 receipt 結算。

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

```js
const attempt = await actuator.submitOnce(
  tab, action, locatorPlan, preparation, options
);
const { receipt: result, commit: finishCommit } = await actuator.inspectAndFinish(
  tab, action, locatorPlan, attempt, preparation, options
);
```

- `send_started` 會保存送出前的總回覆基線；sent 除了所有旗標成立，送後總回覆數還必須至少為「基線＋1」。若 exact reply 出現但總數沒有增加，因果仍不明，只能記 `needs_reconcile`。
- submit 已發生但任何驗證 flag 不成立：自動記 `needs_reconcile`，停止整批。
- 明確沒有執行送出、已不可能送出，而且 exact reply／own author 兩項都為 `false`：可記 `failed`；任何矛盾成功證據都改為 `needs_reconcile`。
- receipt action／preflight／preparation／claim、scope、hash、fingerprint、session 不符或超過 300 秒：拒絕寫入；因可能送錯位置，停止人工檢查。
- `browser-finish` 不接受裸 result JSON；只接受 `{provenance, receipt}` versioned envelope。capability 必須是 `browser-begin` 為同一 action、原 session、scope 與 claim 發出的未消耗 bearer。成功 commit 同時保存完整 receipt digest 並消耗 capability；重播、偽 nonce、錯 action/session/scope 或競態輸家均在 append 前拒絕。
- finish 若為 `needs_reconcile`，commit 後才回傳另一份一次性 reconcile capability；sent／failed 不發下一份 capability。

live P5 不用 raw `finish-send --evidence`。raw `begin-send`／`finish-send` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕。

同 session、同 platform／account／post 只要有另一個 active `needs_reconcile`，domain 會拒絕新的 action 與 preflight。這是 run-level circuit breaker，不依靠 operator 記得停止。

## 6. Reinspection

`needs_reconcile` 下一次先重新載入指定 permalink，搜尋相同 own account＋完全相同 reply＋正確 parent：

- 建立 fresh reinspection receipt，沿用原 action ID、preflight ID、preparation ID、claim ID、scope、fingerprint 與 reply hash；另帶原 `attempt_session_id`、當前 session、observed URL／時間、四項 context flags，以及 `exact_reply_visible`、`own_author_verified`、`absence_verified`、`own_author_reply_count`、`reinspection_total_reply_count`。
- 找到 own-account exact reply，而且目前總回覆數至少為「送出前基線＋1」：`browser-reconcile` 才能寫入 `reconciled_sent`。
- 完整展開且明確確認不存在：只有完全沒有任何 own-author reply，而且目前總回覆數沒有低於送出前基線時，`browser-reconcile` 才能寫入 `reconciled_not_sent`，之後才可重新草擬／核准取得新 permit。若存在 own-author 但文字被平台正規化或與核准文字不完全相同，或目前可見總數低於基線，仍保持不確定，禁止重送。
- `reinspect()`／recovery 也必須重新取得同一份 versioned terminal exhaustion authority；初始空畫面、兩次空 read、無 terminal cursor／traversal、terminal count 與可檢查 collection 不相等時，連可提交的 absence receipt 都不鑄造，recovery 維持 blocked／unknown，不能推導 `reconciled_not_sent`。
- 已核對四項 context flags、但回覆證據仍不確定且符合分類契約：`browser-reconcile` 才追加 `browser_reinspection_observed` 稽核事件，消耗舊 capability、輪替新 capability，狀態仍為 `needs_reconcile` 且不得重送。正向 canary reader 未能建立 context 時不製造 receipt，改回傳 `committed:false`、`reconcile_required:true`，保留既有 attempt／capability、不追加帳本事件；fresh recovery 的前置觀測 unresolved 時也不輪替 authority。禁止捏造 context flags 或以零數量冒充 absence。

完整欄位示例見 [Reinspection JSON example](chrome-comment-validation.md#reinspection-json-example)。

```js
const { receipt: reinspection, commit: reconcileCommit } =
  await actuator.reinspectAndReconcile(
  tab, action, locatorPlan, attempt, attemptSessionId,
  currentSessionId, preparation, options
);
```

`browser-reconcile` 同樣只接受 versioned provenance envelope。reconcile bearer 綁定原 send attempt 的 action、attempt session、scope 與 claim；receipt 的當前 session 仍可不同，但必須與 CLI／bridge 當次 session 完全一致。raw `reconcile` 只保留隔離 fixture ledger 測試，active skill ledger 會直接拒絕。capability 遺失、逾期或 commit 回執不明時 fail closed，維持 `needs_reconcile`，不得重新送出。

平台 anchor 與送出後證據的差異見[驗證層級與平台矩陣](chrome-comment-validation.md#平台矩陣)。平台 adapter 只解讀與操作 live UI；它不能建立 permit、放寬政策、把 unknown 改 sent 或自行重試。
