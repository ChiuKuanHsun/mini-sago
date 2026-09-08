# prompts-local

二乃的人格文字。這個資料夾以 `:ro` 掛進 worker 的 `/etc/minisago/prompts`
（見 `compose.worker.local.yaml`），worker 啟動時載入 存檔後 250ms 內自動重載。

**改語氣不用重建 image 也不用重啟容器**：

```bash
nano ~/mini-sago/prompts-local/identity.md
dcw logs --tail 5 worker      # 看到 Prompt overrides loaded ... 就生效了
```

到 Discord 直接測。改壞了不用回滾 `rm` 掉檔案就回到程式碼裡的內建版本。

| 檔案 | 內容 | 對應的內建常數（都在 `worker/src/prompts/answer.ts`） |
|---|---|---|
| `identity.md` | 她是誰 傲嬌的分寸 吐槽反射 | `BUILTIN_IDENTITY_AND_TONE_INSTRUCTIONS` |
| `chinese-style.md` | 中文標點風格 | `BUILTIN_CHINESE_STYLE_INSTRUCTIONS` |
| `banter.md` | 把抱怨當抱怨 不要變成安全宣導 | `BUILTIN_BANTER_INSTRUCTIONS` |
| `scenarios.md` | 情境範例（示範招式 不是台詞） | `BUILTIN_SCENARIO_INSTRUCTIONS` |

每個檔案的初始內容都跟對應的內建常數逐字相同 所以掛上去之後行為不變。

**只有語氣類的段落搬出來。** 信任邊界（`TRUST_INSTRUCTIONS`）第一人稱機制
（`REFERENCE_RESOLUTION_INSTRUCTIONS`）以及跟輸出 schema 綁死的幾段
（embed table artifact response-shape）刻意留在程式碼裡 —— 那些是機制不是語氣
一次手滑就會拆掉防線或讓輸出對不上 schema。

## 限制

- **不能拿來改她的名字**。`contracts/answer-contract.ts` 的
  `enforceFirstPersonIdentity()` 只認得 二乃 / 中野二乃 / Nino 三個名字
  改成別的會讓她的自我介紹被整則丟棄。載入器會擋下不含這三個名字的
  `identity.md` 並在 log 留一行 `Prompt override identity rejected`。真的要改名
  得同時改 contracts 並重建 core 和 worker。
- **任何檔案裡的 `<self-introduction>` 範例也只能用那三個名字。** 她會照抄範例
  包成別的名字一樣是整則丟棄 所以四個檔案都會檢查這一項。
- 單檔上限 16 KB 空白檔會被忽略。
- 這裡的文字**沒有型別檢查也沒有測試**。建置流程原本是一道閘門 搬出來就沒了
  存檔的瞬間她就照著新的講。
- `worker/src/prompt-eval` 刻意不讀這裡 它量的是內建基準人格。

檔案有進版控 所以 `git diff` 看得出線上人格跟 commit 的差距。
