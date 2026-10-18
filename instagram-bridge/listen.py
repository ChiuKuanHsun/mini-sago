"""第二步：只讀不回。輪詢一個群組，把新訊息印出來，確認抓得到、IG 也不擋。

用法：.venv\\Scripts\\python.exe listen.py <thread_id>
Ctrl+C 結束。
"""

import random
import sys
import time
from pathlib import Path

from instagrapi import Client

SESSION = Path(__file__).with_name("session.json")
POLL_SECONDS = (8, 15)  # 每輪之間隨機停 8-15 秒；固定間隔最像機器


def inbox_seq(cl: Client) -> int:
    """收件匣序號：任何對話有新訊息就會加一。只要一個對話、一則訊息，回應很小。

    原本打 direct_v2/get_badge_count/，2026-10-16 起 IG 回 404「Endpoint does not exist」。
    （當時實測 badge_count 在群組來訊息時仍是 0，不能拿來判斷；seq_id 則確實 12 -> 13。）
    """
    r = cl.private_request(
        "direct_v2/inbox/",
        params={"limit": "1", "thread_message_limit": "1", "persistentBadging": "true"},
    )
    return r["seq_id"]


def main(thread_id: str) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    cl = Client()
    cl.delay_range = [1, 3]
    cl.load_settings(SESSION)

    names: dict[str, str] = {}
    thread = cl.direct_thread(thread_id, amount=1)
    for u in thread.users:
        names[str(u.pk)] = u.username
    names[str(cl.user_id)] = "(二乃小號)"

    # 啟動時已經在群組裡的訊息只記下來、不印，之後只顯示新的
    seen = {m.id for m in cl.direct_messages(thread_id, amount=20)}
    last_seq = inbox_seq(cl)
    print(f"開始監聽「{thread.thread_title}」，已略過 {len(seen)} 則舊訊息，seq_id={last_seq}")

    while True:
        time.sleep(random.uniform(*POLL_SECONDS))
        try:
            seq = inbox_seq(cl)
            if seq == last_seq:
                continue  # 收件匣沒變化，不用抓訊息
            last_seq = seq
            messages = cl.direct_messages(thread_id, amount=20)
        except Exception as e:  # 網路或 IG 暫時錯誤：印出來但不中斷
            print(f"!! 讀取失敗：{type(e).__name__}: {e}")
            continue
        for m in reversed(messages):  # API 回傳新到舊，反過來照時間順序印
            if m.id in seen:
                continue
            seen.add(m.id)
            who = names.get(str(m.user_id), str(m.user_id))
            body = m.text if m.text is not None else f"<{m.item_type}>"
            print(f"{m.timestamp:%H:%M:%S} {who}: {body}")
        cl.dump_settings(SESSION)  # IG 會輪換 cookie，存回去讓下次登入狀態是最新的


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法：python listen.py <thread_id>")
    try:
        main(sys.argv[1])
    except KeyboardInterrupt:
        print("\n結束監聽")
