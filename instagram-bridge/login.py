"""第一步：用小號登入一次，把 session 存成 session.json，並列出 DM 對話確認讀得到。

之後的腳本都從 session.json 載入，不再帶密碼登入——反覆用密碼登入正是 IG 最常觸發
checkpoint 的原因。session.json 等同登入憑證，不要分享或 commit。

容器裡重新登入（一定要走 VPN，不要在 host 上跑）：
    docker compose -f compose.instagram.yaml run --rm -it --entrypoint python instagram login.py
"""

import os
from getpass import getpass
from pathlib import Path

from instagrapi import Client

SESSION = Path(os.environ.get("IG_SESSION_FILE") or Path(__file__).with_name("session.json"))


def main() -> None:
    cl = Client()
    cl.delay_range = [1, 3]  # 每個請求之間隨機停 1-3 秒，比較像真人
    cl.challenge_code_handler = lambda username, choice: input(
        f"IG 寄了驗證碼給 {username}（{choice}），請輸入：").strip()

    username = input("小號帳號：").strip()
    password = getpass("密碼（輸入時不會顯示）：")
    code = input("兩步驟驗證碼（沒開就直接 Enter）：").strip()

    cl.login(username, password, verification_code=code)
    cl.dump_settings(SESSION)
    print(f"\n登入成功，session 已存到 {SESSION}\n")

    for t in cl.direct_threads(amount=20):
        kind = "群組" if t.is_group else "私訊"
        title = t.thread_title or ", ".join(u.username for u in t.users)
        print(f"[{kind}] {t.id}  {title}  ({len(t.users) + 1} 人)")


if __name__ == "__main__":
    main()
