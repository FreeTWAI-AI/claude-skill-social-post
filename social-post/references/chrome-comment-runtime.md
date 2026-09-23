# Chrome Comment Runtime

> last_verified: 2026-09-05
> scope: P5 的來源 Chrome binding、重連、tab 生命週期與只讀節點辨識。

在建立／恢復連線、取得 tab 或辨識 Threads icon-only 控制前讀本文件。授權、送出與對帳契約仍以 [Chrome Comment Adapter Protocol](chrome-comment-adapter.md) 為準；連線成功不代表取得送出權。

## 當前 CUA 工具路徑

當工具提供 `cua.getState/getTab/createBrowserTab` 時，只在該工具的持續執行環境中
匯入 `scripts/comment_chrome_actuator.mjs`，以實際的 `cua` 與剛讀到的 Chrome browser ID
呼叫一次 `await createCommentCuaActuator(cua, { browserId })`，使用其回傳的 actuator。
此單一入口在同一 module graph 初始化與建立 actor，避免分別匯入時取得不同 runtime
實例。來源自行從 fresh state 解析 tab，不接受 operation
caller 指定 tab、receipt、resolver 或 callback。初始化失敗、Chrome identity 改變或
權限拒絕即停；不改用舊 SDK、不偽造 RPC，也不以重綁清除 uncertain attempt。

這是官方工具 host 注入的信任邊界；JavaScript 物件形狀／WeakSet 不能證明任意物件
來自官方 runtime。它不宣稱 browser-client hash 認證、physical document epoch 或
持久 DOM node identity。不得讀未文件化的 `dom_cua`／內部 transport。

CUA fused 路徑沿用同一 target intake、durable claim、finish 與 recovery 帳本。
Threads 使用原生零回覆與來源選取 modal；2026-09-05 的單次送出已經唯讀 recovery
結算為 `reconciled_sent`，沒有重送。IG 已接入正數回覆展開、零 own baseline、來源點選
及原生 `@author ` 前綴的 semantic v2 preparation；離線整合與 recovery 分流通過，
當前 CUA 的真實 IG 送出仍未驗證，不能引用舊 SDK 成功替代。最後一次 lease 檢查
後，重新核對原留言、actor、modal、完整核准文字及唯一可用送出鈕，再以文件化
locator click 點一次。這是語義 UI continuity，仍有 DOM 變化競態；不把 click 回傳
當成功，必須查到正確父留言下的新 exact-own 原生子回覆並完成有效帳本結算。
呼叫 submit 後的錯誤／timeout／查不到結果一律 unknown 並停止，不 retry；送出前
不支援或驗證失敗則停止，不偽稱已嘗試送出。FB 送出在填字與 claim 之前拒絕，直到其
CUA selection contract 完成。此路徑不升級泛用 production、fixture 或實體節點能力。
IG 對帳只走原生回覆展開與正向讀取，不能呼叫要求零 own baseline 的 selection。
內部 ownership 檢查使用 `getState({emit:false})`；仍逐次取得 fresh state，不快取或省略查核。

FB 登入身分檢查另由來源建立固定 `/me/` 暫時分頁，核對核准 profile 的穩定原生跳轉後
只關閉自己的 probe；不導航原留言頁。這只驗登入身分，不證明 composer 的 Page／profile actor。

以下舊 runtime 只適用仍提供對應已文件化 SDK 的環境。固定套件不存在時不可使用，
不能只改 pin 便宣稱已支援目前 CUA。

## 連線與操作範圍

1. 舊 SDK 環境依 `chrome:control-chrome` 使用 Google Chrome；P5 fused 程式從 `comment_chrome_runtime_authority.mjs` 的 `getSourceOwnedChromeBrowser()` 取得並快取 browser。操作方也重用這個 getter 回傳的 binding，完整讀取其 runtime documentation、命名 session 後才操作；不要另做第二套 setup／get 導致操作方與來源程式各持不同 binding。當前 CUA 依上一節路由，不執行舊 getter。
2. 使用指定貼文 permalink；不要從首頁猜貼文。
3. 沿用同一 browser binding。tab 遺失時只重新取得 tab，不重新初始化整個 browser runtime。
4. 遇登入、2FA、CAPTCHA、checkpoint、限制訊息或錯誤 banner，停止，不建立 authenticated scan。
5. 舊操作方 binding 失效不等於整個 Chrome 離線；先檢查已存在的來源持有 binding。不能以重複初始化修復 tab，也不要求使用者關閉整個 Facebook。需要收起聊天浮窗時只辨識收合／關閉控制，不讀私訊、不刪對話；無法安全收起時維持貼文容器內的唯讀範圍。

## 舊 SDK 來源持有的限定重連

僅舊 SDK 的來源 runtime revision `2026-08-31.2` 提供零參數 `recoverSourceOwnedChromeBrowser()`；
此入口不是當前 CUA 的重連方案。
它自行探測 cached browser，只有真實 Error 與 cached browser ID 完全相符的
`Browser is not available: <ID>` 才允許同來源、同 Chrome family 重選一次；空 tabs、
一般 timeout、stale tab、權限拒絕都不能觸發。replacement 的選取／health probe
失敗會保留失敗狀態；既有 claim、reservation 與 uncertain attempt 不會清除，
也不會重新導航或重送。2026-08-31 已在一次真實斷線後，透過此入口接回並完成
原指定 Threads 留言的來源讀取；這不表示所有斷線原因都已修好。

## 指定留言與唯讀 recovery 的 exact-tab reuse

target-only intake 與唯讀 recovery 共用來源自己的新鮮 tab 清單尋找 exact permalink：
唯一相符時借用並保留該 tab，不因開始檢查而 reload，結束不關閉；零相符才建立
自己的暫時 tab。一般 intake 遇多個相符仍停止；唯讀 recovery 則建立自己的 exact-target
暫時 tab，不任選或關閉既有相符分頁。handle ID 和 URL 在取得及檢查完成後都再次核對，
不接受 caller 指定 tab 或 browser。送出仍使用來源建立的專用 tab，不沿用借用規則。

recovery 前置觀測須在 wrapper 的最後一次 identity／URL 核對通過後，才可輪替
authority；其後再經一次 fresh wrapper 觀測及最後核對，才提交 receipt。
CUA Threads 正向 reader 在獨立、來源建立的暫時分頁開啟當下觀測到的 own-child permalink，
驗證 immediate parent／own account／完整本文，保留原留言頁不導航；legacy 才沿用
導覽後還原。未能查證或最終 parent 檢查失敗即維持 unknown，不送出、不重送；前置觀測 unresolved 時不輪替 capability，已有
recovery context 的 unresolved 則保留現有 capability，回傳 `committed:false`。
2026-09-05 已用此路徑完成真實 Threads 唯讀結算，canonical 原 attempt 為 `reconciled_sent`。
舊分頁的 debugger／DOM 失效不代表整個 Chrome 離線；fresh tab 清單或 URL 可讀也不代表
原生內容可查。未知時依具體證據處理，不反覆使用同一失效 handle，也不重送原回覆。

## Threads icon-only 控制辨識

當前 CUA 在已核對的 exact native parent 容器內，以唯一可見的精確 SVG aria-label
定位 icon-only「回覆」控制；來源 click 後還要驗證 modal 的原留言、actor 與空 editor。
semantic locator 不等於持久 node ID，不使用 `dom_cua` 或 expando。

舊 SDK／隔離 fixture 另有嚴格只讀 node binder：原生 DIV 的 innerText
為空時，只接受唯一可見 SVG 的精確 aria-label／TITLE；TITLE 之外的隱藏或可見
文字、額外圖示、歧義 identity 或 node 漂移都拒絕。不把 generic／IG binder 改為
textContent fallback；取得 node ID 本身不構成父留言選定、claim 或送出授權。

## UI 變更與限制

UI 改版只在既有授權範圍內更新平台 reader／selection／result 模組與相應測試；
共用 ledger、permit、claim 與 receipt 契約不因 selector 改變而放寬。登入挑戰、
CAPTCHA、checkpoint、權限拒絕或平台限制必須暫停，不以換 URL、runtime、帳號
或重試繞過，也不承諾不中斷運作。
