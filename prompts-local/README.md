# prompts-local

二乃的人格文字。這個資料夾以 `:ro` 掛進 worker 的 `/etc/minisago/prompts`
（見 `compose.worker.local.yaml`），worker 啟動時載入 存檔後 250ms 內自動重載。

**改語氣不用重建 image 也不用重啟容器**：

```bash
nano ~/mini-sago/prompts-local/identity.md
dcw logs --tail 5 worker      # 看到 Prompt overrides loaded ... 就生效了
```

到 Discord 直接測。改壞了不用回滾 `rm` 掉檔案就回到程式碼裡的內建版本。

| 檔案 | 對應的內建常數 |
|---|---|
| `identity.md` | `worker/src/prompts/answer.ts` 的 `BUILTIN_IDENTITY_AND_TONE_INSTRUCTIONS` |

`identity.md` 的初始內容跟內建常數逐字相同 所以掛上去之後行為不變。

## 限制

- **不能拿來改她的名字**。`contracts/answer-contract.ts` 的
  `enforceFirstPersonIdentity()` 只認得 二乃 / 中野二乃 / Nino 三個名字
  改成別的會讓她的自我介紹被整則丟棄。載入器會擋下不含這三個名字的檔案
  並在 log 留一行 `Prompt override identity rejected`。真的要改名 得同時改
  contracts 並重建 core 和 worker。
- 單檔上限 16 KB 空白檔會被忽略。
- 這裡的文字**沒有型別檢查也沒有測試**。建置流程原本是一道閘門 搬出來就沒了
  存檔的瞬間她就照著新的講。
- `worker/src/prompt-eval` 刻意不讀這裡 它量的是內建基準人格。

檔案有進版控 所以 `git diff` 看得出線上人格跟 commit 的差距。
