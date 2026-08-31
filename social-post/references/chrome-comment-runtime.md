# Chrome Comment Runtime

> last_verified: 2026-08-31
> scope: P5 的來源 Chrome binding、重連、tab 生命週期與只讀節點辨識。

在建立／恢復連線、取得 tab 或辨識 Threads icon-only 控制前讀本文件。授權、送出與對帳契約仍以 [Chrome Comment Adapter Protocol](chrome-comment-adapter.md) 為準；連線成功不代表取得送出權。

## 連線與操作範圍

1. 依 `chrome:control-chrome` 使用 Google Chrome；P5 fused 程式從 `comment_chrome_runtime_authority.mjs` 的 `getSourceOwnedChromeBrowser()` 取得並快取 browser。操作方也重用這個 getter 回傳的 binding，完整讀取其 runtime documentation、命名 session 後才操作；不要另做第二套 setup／get 導致操作方與來源程式各持不同 binding。
2. 使用指定貼文 permalink；不要從首頁猜貼文。
3. 沿用同一 browser binding。tab 遺失時只重新取得 tab，不重新初始化整個 browser runtime。
4. 遇登入、2FA、CAPTCHA、checkpoint、限制訊息或錯誤 banner，停止，不建立 authenticated scan。
5. 舊操作方 binding 失效不等於整個 Chrome 離線；先檢查已存在的來源持有 binding。不能以重複初始化修復 tab，也不要求使用者關閉整個 Facebook。需要收起聊天浮窗時只辨識收合／關閉控制，不讀私訊、不刪對話；無法安全收起時維持貼文容器內的唯讀範圍。

## 來源持有的限定重連

來源 runtime revision `2026-08-31.2` 提供零參數 `recoverSourceOwnedChromeBrowser()`。
它自行探測 cached browser，只有真實 Error 與 cached browser ID 完全相符的
`Browser is not available: <ID>` 才允許同來源、同 Chrome family 重選一次；空 tabs、
一般 timeout、stale tab、權限拒絕都不能觸發。replacement 的選取／health probe
失敗會保留失敗狀態；既有 claim、reservation 與 uncertain attempt 不會清除，
也不會重新導航或重送。2026-08-31 已在一次真實斷線後，透過此入口接回並完成
原指定 Threads 留言的來源讀取；這不表示所有斷線原因都已修好。

## 指定留言的 exact-tab reuse

target-only intake 由來源自己的新鮮 tab 清單尋找 exact permalink：唯一相符時只讀
並保留該 tab，不 reload、不關閉；零相符才建立自己的暫時 tab，多個相符則停止。
handle ID 和 URL 在取得及雙讀完成後都再次核對。這是唯讀入口的生命週期處理，
不改動送出／對帳使用的 tab 流程，也不接受 caller 指定 tab 或 browser。

## Threads icon-only 節點辨識

Threads 的 icon-only「回覆」控制另有嚴格只讀 node binder：原生 DIV 的 innerText
為空時，只接受唯一可見 SVG 的精確 aria-label／TITLE；TITLE 之外的隱藏或可見
文字、額外圖示、歧義 identity 或 node 漂移都拒絕。不把 generic／IG binder 改為
textContent fallback；取得 node ID 本身不構成父留言選定、claim 或送出授權。
