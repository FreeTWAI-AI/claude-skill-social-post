# X 發文與 For You 推薦

> last_verified: 2026-09-23
> source_revision: `xai-org/x-algorithm@3aa0fa336c4a20e4149b6151629b6050897bb8a5`（2026-09-22）
> scope: X「For You」公開倉庫；不代表 Following、搜尋、通知、廣告或所有線上實驗。

## 原始碼能確認的事

- For You 每次請求結合追蹤帳號的近期貼文，以及 Phoenix／SimClusters 找到的非追蹤帳號貼文，再過濾、排序與重排。它不是一篇貼文固定擁有的「全站流量分數」。[官方架構](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/README.md#overview)
- Phoenix 預測**該讀者**對各種動作的可能性，包括喜歡、回覆、轉發、引用、分享、點擊、停留、追蹤，以及不感興趣、靜音、封鎖、檢舉。排名器以權重組合這些預測；權重不是實際互動次數的兌換率。不可說「一則回覆抵 N 個讚」或依公開預設權重計算某篇的真實分數。[官方說明](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/README.md#scoring-and-ranking) · [排名程式](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/home-mixer/scorers/ranking_scorer.rs)
- 排序還有作者多樣性、非追蹤內容折減、新作者調整與 VMRanker 重排；可見性、已看過、重複、封鎖／靜音、部分對話分支等過濾也會影響出現機會。來源點擊或單一貼文格式不足以保證觸及。[官方說明](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/README.md#filtering)
- `home-mixer/params/param.rs` 的數字是公開時的主要預設，線上實驗與設定可變；9 月 18 日更新了可見性標籤的透明資訊。部分防濫用規則與提示詞未公開，因此不能聲稱已掌握完整線上演算法。[設定邊界](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/README.md#experiments-and-configuration) · [未公開部分](https://github.com/xai-org/x-algorithm/blob/3aa0fa336c4a20e4149b6151629b6050897bb8a5/README.md#whats-not-in-this-repo)

## Social Post 如何使用

1. P0／P2：先選讀者、題材與唯一目的，寫清楚「這篇提供什麼、為誰而寫」。首句、長度、媒體、連結、hashtag、發布分鐘都是**創作或測試變因**，公開碼沒有給它們通用加分公式。不要為迎合權重製造互動誘餌。
2. P2：依 `voice_quick.md` 和同平台、同類型、同成熟度的 comparables 寫稿。`x-post-engine` 可提供 hook／thread 範例，但它的字數、hashtag、發文時段或固定演算法效益若與本檔或當前官方證據衝突，以重新驗證後的來源與 Social Post 私有實測為準。
3. P3：保存每則 X 貼文的實際發布時間、timezone、原文、格式與平台可見的 impressions／views、回覆、喜歡、轉發、引用、分享、點擊、停留、追蹤或轉化；沒有的欄位用 `null`，不以公開權重推算「演算法分數」。每個快照保留 `captured_at`、maturity 與 UI 口徑。
4. P4：只比較同平台、同內容類型、同 maturity 且分析合格的貼文；對 hook、版型、連結、媒體與時段建立可反駁假設，記錄同時變動的 confound。公開碼只能說明可能的分發機制，不能證明某次觸及變化的原因。規則升級仍走 experiment 與 rule metadata backlink。
5. 重新引用演算法或調整策略前，核對官方倉庫的新 commit／README／相關程式；把核對日期與 commit 記在本檔。若出現新實驗或來源缺口，保留 `unknown`，不沿用舊權重作承諾。

## 文字與發布

- 一般貼文上限通常為 280，Premium 長文可到 25,000；以當前官方說明及實際 composer 計數為準，不硬寫中文、emoji、網址各算幾字。[X 貼文類型](https://help.x.com/en/using-x/types-of-posts)
- 超出帳號可用長度時可縮短或拆成 thread；第一則應能獨立表意。hashtag、外部連結與媒體按內容需要決定，不能宣稱固定加分或固定懲罰。
- 實際發布才檢查已登入 UI 與當前權限；送出結果不明時先查貼文是否已存在，停止自動重試，避免重複發文。不要把快捷鍵、selector 或固定等待秒數當成跨版本保證。
