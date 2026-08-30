# Chrome Comment Adapter 驗證層級

> 主協定：[Chrome Comment Adapter Protocol](chrome-comment-adapter.md)
> last_verified: 2026-08-30

- `node scripts/comment_chrome_actuator_test.mjs`：純 Node fail-closed、parent binding、零基線、併發與 actor recreation regression。
- `node scripts/comment_chrome_scan_adapters_test.mjs`：production/fixture registry 隔離、brand／immutability、raw-live／clone／跨平台拒絕、cursor／terminal exhaustion、monotonic count、遲到控制／留言、virtualization 與 same-fingerprint replacement 零點擊 regression。
- `comment_chrome_node_frame_mapping.mjs` 只保留 production-safe schema、平台驗證與 immutable descriptor；final-scan DOM reader、WeakSet process brand 與 attestation 全移到 `comment_chrome_node_frame_mapping_testonly.mjs`，且沒有 compatibility re-export。`comment_chrome_node_frame_mapping_test.mjs` 只校準 FB／IG／Threads final-scan 綁定；六階段 fixture lifecycle 已拆到 actuator manifest 明確呼叫的 `comment_chrome_node_frame_lifecycle_test.mjs`，實作由明確標示 `*_testonly.mjs` 的 session/attestation 與 snapshot reader 負責，production mapping 不反向依賴 fixture。exact `expand → reply_trigger → composer_fill → submit_preflight → finish → recovery_reinspection` 每階段固定雙讀，沿用 frame、document epoch、comment identity、parent anchor 與 node roles，並以 process-brand、前階 attestation、一次性 consume、stage order 與 reply cardinality 封閉重播；brand／順序／跨平台／clone、frame／epoch／node／parent／comment 漂移、role collision、錯誤 finish cardinality 與 recovery rerender 全部 fail closed。輸出的 `test_only_full_lifecycle_mapping` 仍只來自 fake fixture；序列化後 Python 最多承認 non-authoritative structural report，不能保存 JS process-brand，也不證明 native Chrome frame owner。
- `node scripts/comment_chrome_host_authority_test.mjs`：source-wired read-only host/document facade 的三平台 exact permalink、wrong host/path、HTTP、固定 browser-client import、既有 tab exact-object claim、禁止 caller authority input，以及 launch／navigation／DOM mutation／storage 靜態負測試。固定 runtime 在 import 前先驗證 148,173 bytes 與完整 SHA-256；缺檔、版本、size 或 digest 漂移都 fail closed。負測試另阻擋 node 插刪、attribute mutation、event dispatch、`textContent／innerHTML／outerHTML`、表單 value、location／history 與 `document.write` 回歸；它是 source detector，不是 AST sandbox。獨立 Node 程序沒有 trusted browser service 時必須 fail closed；這只證明 source contract，不能取代已登入真 Chrome canary 或升級 live capability。
- `comment_test_trusted_host_verifier.py`：完全離線的 callable promotion-verifier calibration；使用隔離 test authority 驗證 fresh challenge、authority／session／run／source／time／三平台逐欄 binding、replay 拒絕，以及 browser launch／mutation 永遠為 `0`。production promotion facade 仍維持 unavailable，直到 source-wired JavaScript runtime attestation 經已登入 canary 後接入受信任 receipt bridge；測試 authority不能安裝到 facade、不能啟動 Chrome、不能升級 capability。
- `node scripts/comment_chrome_claim_bridge_test.mjs`：durable claim 的 live/test 邊界與逐欄 binding。
- `node scripts/comment_chrome_claim_integration_test.mjs`：兩個獨立 Python 程序競逐同一 durable claim，驗證只允許一個成功並只追加一筆 `send_started`。
- `node scripts/comment_js_architecture_gate.mjs --self-test`：先以 known cycle、精確 role 誤標、production→test／fixture_testonly boundary、missing required edge、輸出 traversal／symlink 與原子寫入中斷負 fixture 校準 JavaScript 量尺。
- `node scripts/comment_js_architecture_gate.mjs --output .rd/receipts/js-architecture-gate.json`：對 closed inventory 建立 static import／export-from graph，執行 Tarjan SCC、精確 role boundary 與 required-edge gate，保存只含相對路徑與 SHA-256 的同版 receipt。
- `comment_fixture_browser_e2e.mjs`：需 Browser Plugin backend；唯一 evidence runner 會自行啟動 ephemeral `127.0.0.1` server，依固定 `facebook → instagram → threads` 順序載入 source-bound fixture，並直接測 send core 的 DOM/fill/click/reinspect。直接執行 `node scripts/comment_fixture_browser_e2e.mjs` 必須以 `NOT_RUN` 非零退出；真正測試只能在已綁定 controlled Browser tab 的 session 匯入並呼叫 `runAllFixtureBrowserE2E(tab)`。不得傳入外部 server、平台 subset、自訂順序或 live URL。三平台 PASS 後另跑 `python scripts/comment_fixture_promotion_envelope.py --write`，把 rich raw receipt 的精確 bytes/hash 映射成 canonical、限時、`promotion=false` 的 test-only envelope。
- `comment_chrome_fixture_contract_test.mjs`：不開瀏覽器的 exact-batch、loopback、canonical receipt mutation negatives、active-state missing→empty，以及 atomic writer／lock／readback 契約。fixture receipt 固定留在 private `.rd/receipts/`，必須標記 `capability_promotion_eligible=false`、`live_browser_actuation_enabled=false` 與 `claim_authority=in_memory_test_only`。
- 真實 FB／IG／Threads：仍需已登入 Chrome、當前 UI 的 fresh locator plan 與使用者授權 canary；fixture 綠燈不能替代 live canary。

`tab.playwright.domSnapshot()` 可看出 frame topology；`dom_cua.get_visible_dom()` 目前不帶 frame owner。這版因此採最保守的 main-frame-only contract：snapshot 只要出現 iframe 就拒絕，且所有 live mutation 仍關閉。這個 regex／root／epoch contract 是 canary 前的防誤接線，不是瀏覽器來源證明；只有 runtime 提供不可偽造的 Chrome tab provenance 並以已登入頁面完成 read-only canary 後，才可重新評估 `TRUSTED_CHROME_HOST_RESOLVER`。

## Production promotion 權威

- `.rd/capability-ledger.json` 是能力狀態的唯一 canonical authority；只有它能把 obligation 維持 open、標成 verified 或降級。任何 receipt、測試報告與公開檔案都不能自行改狀態。
- `comment-capabilities.json` 只是由 private canonical ledger 產生的 non-authoritative structural report。它的 canonical／payload SHA-256 只能協助比對漂移；缺少 private canonical parity 或受信任 attestation 時，`--projection-only` 只能證明結構可解析，不能證明內容來源、verified 狀態或 production eligibility。
- 磁碟上的 static JSON receipt、`status=PASS`、來源 hash、self-authored boolean 或新鮮時間戳都只是待驗證輸入，不能升級 live production。`TRUSTED_CHROME_HOST_RESOLVER` 的 JavaScript runtime boundary 已 source-wire 到既有 Chrome session，且不能自行啟動 Chrome、導覽或接受 caller/test authority；但尚無已登入三平台 canary，也尚未接入 canonical promotion receipt/verifier，因此 obligation 仍為 planned。`THREE_PLATFORM_BROWSER_FIXTURE` 另有一個只接受 fresh raw receipt＋detached SHA＋current source/architecture binding 的 test-only envelope verifier；它固定拒絕 trusted-host、stable-mapping 與 live-actuation claim。其餘四個 live successor verifier 仍未接入；在 genuine Chrome runtime provenance、predecessor 與 authenticated canary 尚未完成前，六項 obligation 全部維持 open。
- `test_only_full_lifecycle_mapping` 是獨立於 production `REQUIREMENTS`／receipt writer／callable verifier 的測試證據類別。它必須明示 `test_only=true`、`capability_promotion_eligible=false`、`browser_receipt_eligible=false`、`live_browser_actuation_enabled=false`、`live_plan_minting=false`，且只可對 exact source closure、三平台六階段結構與負測試做離線校準。即使結構與 digest 全部通過，也不能鑄造 `STABLE_NODE_FRAME_MAPPING` receipt、不能改 canonical ledger、不能解除 successor DAG。
- 不得把設定值、環境變數、一個字串狀態或 fixture factory 當成 trust switch。既有 session verifier 必須 fail closed：receipt 要逐欄綁定 obligation／gate／scope、product version、source revision、capability contract、policy、exact source inventory、authority、run、當前 session 與有效時間；每次產生 fresh challenge，三平台 account／post／runtime／document／frame 結果必須原樣綁定，launch 與 mutation 都必須為精確整數 `0`。後續能力還要綁定 parent/comment、reply hash、grant、permit、claim、action 及 child execution receipt。
- grant、permit、claim、action、execution receipt 與 `(platform, account, post, parent/comment)` 必須 one-time 且不可跨 session／貼文重播；同一 parent 不能只換 action ID 就再次通過。grant 有效期不得超過 receipt 與當前 session 的共同有效窗，任何重複、未知或無法對帳的結果都停止整批。

### Exact promotion DAG

promotion dependency graph 是 closed-world exact contract；target 只有在所有 direct predecessor verified、且其 transitive closure 也完整時才可評估。不得跳級、用空白／別名狀態繞過，亦不得出現未知節點、self-edge 或 cycle。

| obligation | direct predecessors |
|---|---|
| `TRUSTED_CHROME_HOST_RESOLVER` | 無 |
| `STABLE_NODE_FRAME_MAPPING` | `TRUSTED_CHROME_HOST_RESOLVER` |
| `THREE_PLATFORM_BROWSER_FIXTURE` | `TRUSTED_CHROME_HOST_RESOLVER`、`STABLE_NODE_FRAME_MAPPING` |
| `THREE_PLATFORM_LIVE_DRAFT` | `THREE_PLATFORM_BROWSER_FIXTURE` |
| `LIVE_BATCH_CONFIRM` | `THREE_PLATFORM_LIVE_DRAFT` |
| `LIVE_BOUNDED_AUTO` | `LIVE_BATCH_CONFIRM` |

`THREE_PLATFORM_BROWSER_FIXTURE` 即使完成 Browser 實跑，也只可證明 source-bound localhost test path；它的 receipt 必須維持 `capability_promotion_eligible=false`、`live_browser_actuation_enabled=false` 與 test-only claim authority。fixture 不得替代 authenticated Meta canary、trusted verifier、stable live mapping、使用者授權或任何 live predecessor，也不得把 downstream live obligation 升級。

## 平台矩陣

| 平台 | 強 anchor | 送出後必要證據 |
|---|---|---|
| Facebook | comment permalink／comment ID | 同一留言下的 own-account exact text |
| Instagram | IG comment permalink／stable ID | 正確 post 的展開回覆串內 exact text |
| Threads | reply permalink／post ID | 正確 parent thread 下的新 reply permalink 或 exact text |

## JavaScript architecture gate

closed inventory 固定涵蓋所有 `scripts/comment_chrome_*.mjs`、`scripts/comment_js_architecture_*.mjs`、`scripts/comment_fixture_browser_e2e.mjs` 與 `scripts/comment_adapter_fixtures/fixture-runtime.js`；新增符合 glob 的模組會自動被發現，但在加入 reviewed exact manifest 與 exact role map 前一律 FAIL，刪除既有 member 或 role 誤標也 FAIL，不存在 suffix/default production fallback。gate 解析 static `import`／`export ... from`（包含同一行的多個 statement），並深入可含 regex literal 的 template `${...}`；受校準的直接語法會阻擋 dynamic `import()`、`createRequire()`、`eval()`、`Function()` 與非明確 `node:` builtin 的 executable `require()`。唯一例外是 runtime authority 內 source/specifier/kind/count 全部固定的 browser-client lazy dynamic import；actual receipt 必須精確列出這 1 條 reviewed external dependency，missing、duplicate、eager/static 或任一欄漂移都 FAIL，`graph_sha256` 也涵蓋它。loader-shaped bare reference／alias 及 executable dot／bracket member同樣 fail closed；只有 quoted 純資料字串不會被當成 loader。relative edge 必須留在 closed inventory，`node:` 以外的 bare import 也 fail closed。這是 source drift detector，不是完整 JavaScript AST、惡意字串混淆分析器或執行 sandbox；PASS 不得被解讀為已證明任意 adversarial loader 不存在。固定相對路徑、size 與 bytes digest 也不等於已證明 canonical install root 或排除所有 symlink 情境。test→test 只允許測試 runner／fixture orchestration，production→test 仍由負 fixture 明確阻擋。

阻擋條件：任何 SCC cycle、production 越界 import test／E2E／fixture、`fixture_testonly` 被非 test／E2E 使用、`comment_chrome_send.mjs → comment_chrome_claim_bridge.mjs` 反向邊，或下列 required edge 消失：

- actuator → claim_bridge
- actuator test runner → scan／send／guards／receipts／reply-exhaustion／reinspection 六個直接 spec，以及 fixture contract test
- claim_bridge → common／scan／send
- send → reply_exhaustion／common／send_support
- send_support → reply_exhaustion／common
- reply_exhaustion → common
- scan → common／scan_adapters
- scan_adapters → common
- fixture scan testonly → common／scan
- fixture browser E2E → common／fixture evidence／fixture receipt／fixture scan testonly／send core
- fixture contract test → common／fixture browser E2E／fixture evidence／fixture receipt
- fixture evidence → common
- fixture receipt → common

receipt 的 `evaluator_sha256` 綁定 gate／contract／core／loaders／receipt／selftest 六個 evaluator 的實際 bytes；`inventory_sha256`、`graph_sha256`、`policy_sha256` 與 `report_sha256` 則是本次 inventory／含 reviewed external dependency 的圖／政策／報告證據，所有路徑保持相對。fixture runner 會再把這六個 evaluator 納入當次 source snapshot，重新枚舉並逐 byte 核對完整 closed inventory，再精確核對 `evaluator_files`、external dependency 與 browser-client bytes，並重算 evaluator、inventory 與 graph digest；因此舊版／弱化 evaluator、外部 boundary 或任一 inventory member 漂移後留下的 PASS receipt 都不能被當成 fresh。receipt 與 `<receipt>.sha256` detached hash 都以同目錄 exclusive temp、flush、atomic rename、readback 寫入；注入 rename 前失敗時必須保留舊檔並清掉受約束 temp。`comment_self_test.py` 仍以實際 receipt bytes 重算 sidecar 並逐字比對。`--output` 只接受 immediate `.rd/receipts/*.json`，逐層拒絕 symlink／junction，既有 receipt 與 sidecar 也必須是 regular non-symlink file，不能拿 gate 覆寫 source、`SKILL.md` 或任意路徑。`.rd/**` 已從 Cleanup inventory 排除，避免 evidence 自我引用。這是 social-post 的產品原生 JS gate，只補足 Cleanup 對 JavaScript architecture 的 `NOT_CHECKED`；不得回寫或改稱 Cleanup provider 本身已通過跨語言架構驗證。

三平台 Browser fixture 另在 `finally` 比對全部 `data/` inventory、policy、canonical capability ledger、公開 projection 與實際 dependency source bytes；缺檔與新建空檔必須可區分，lock／temp／任一 parent junction 或 symlink 漂移都要阻擋。native gate 同時鎖定 E2E 的五個直接 target、完整 transitive module closure、禁止未審核的 Node builtin／global／loader 權限，並把 filesystem authority、Node imports 與 public function surface 限縮到逐模組 exact allowlist；fixture closure 只核准 E2E runner 的 `typeof process` 與 `process.argv`，`process.pid`、`process.binding`／`_linkedBinding`／`getBuiltinModule`、computed／alias 變形與 `globalThis.process` 一律 fail closed。固定 receipt persistence 是 E2E runner 的 module-private 路徑，不存在可接收合成 PASS JSON 的公開 writer；發布時持有 Social Post 合作式 writer 共用的 `data/.write.lock`，先 stage、發布前後重驗 protected state。若 half-publish、readback 或 cleanup 失敗，會先恢復發布前已驗證的舊 receipt pair；恢復也失敗時才刪除整對檔案並 fail closed。這把鎖只序列化遵守同一協議的 Social Post writer，不代表作業系統或其他程式的全域 serialization；crash 留下 stale lock 時需人工確認並復原，fixture 仍不可升級正式能力。send／scan core 仍不得取得 fs write authority。2026-08-30 已完成受控 localhost Browser E2E：FB／IG／Threads 各掃到 2 則 fixture 留言、各恰有 1 次 test-only submit attempt，並確認正確 parent 與 exact reply 可見；receipt 仍固定為 `localhost_test_only_candidate`、`capability_promotion_eligible=false`、`live_browser_actuation_enabled=false`。它沒有接觸真實 Meta，也不證明已登入 Meta host、trusted Chrome host、穩定 live tab/frame/document mapping、live draft／send 或 bounded auto eligibility，因此不得自動升級 capability ledger 或打開 live policy。
