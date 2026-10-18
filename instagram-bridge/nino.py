"""接上 MiniSago：有人叫二乃時，把群組最近的訊息送給 VM 上的 core，由她本人回覆或按表情。

什麼時候算在叫她（跟 Discord 一致）：
- mention：訊息裡 @ 了她
- reply：回覆她的訊息
- continuation：她剛回完某人，那個人 5 分鐘內的下一則訊息，而且中間沒有別人插話、
  沒有 @ 任何人。這種她可以選擇不回。

各種訊息怎麼解讀在 ig_items.py。

設定：容器裡用環境變數（見 compose.instagram.yaml）
    MINISAGO_INSTAGRAM_BRIDGE_URL、MINISAGO_INSTAGRAM_BRIDGE_SECRET、
    IG_THREAD_ID、IG_SESSION_FILE
沒有環境變數時退回同一個資料夾的 bridge.json：
    {"url": "http://100.92.254.36:3100/api/internal/instagram-reply", "secret": "..."}
secret 要跟 VM 上 .env.production 的 MINISAGO_INSTAGRAM_BRIDGE_SECRET 一樣。

用法：python nino.py [thread_id]
Ctrl+C 結束。
"""

import json
import os
import random
import sys
import time
import traceback
from pathlib import Path

import requests
from instagrapi import Client
from instagrapi.types import DirectMessage

from ig_items import Shared, describe, shared_media
from listen import inbox_seq

HERE = Path(__file__).parent
SESSION = Path(os.environ.get("IG_SESSION_FILE") or HERE / "session.json")
CONFIG = HERE / "bridge.json"
# 當掉後 docker 會自動重啟；先睡一段再結束，避免 session 失效時一直重新連 IG 觸發風控
CRASH_BACKOFF_SECONDS = 300
HISTORY = 20               # 每次送給二乃的最近訊息數
COOLDOWN_SECONDS = 5       # 兩次回覆至少間隔這麼久；模型本身要好幾秒，實際間隔會更長
SEEN_DELAY = (0.5, 1)      # 看到訊息後停一下才標已讀，秒讀也像機器
TYPING_DELAY = (0.5, 1)    # 模型本身就要好幾秒，這裡只補一點
CONTINUATION_SECONDS = 5 * 60
# 群組最近有人講話就查快一點，安靜時放慢，平常的請求量不會暴增
ACTIVE_WINDOW = 5 * 60
POLL_ACTIVE = (2, 4)
POLL_IDLE = (10, 20)
REQUEST_TIMEOUT = 150      # core 那邊一則回答最久可能跑到 1-2 分鐘


def to_payload(m: DirectMessage, users: dict[str, tuple[str, str]], me: str, shared: dict[str, Shared]) -> dict:
    uid = str(m.user_id)
    username, full_name = users.get(uid, (me, "") if m.is_sent_by_viewer else (uid, ""))
    item = describe(m)
    text, images = item.text, item.images
    extra = shared.get(str(m.id))
    if extra is not None:
        if extra.caption and "貼文說明：" not in text:
            text += f"\n貼文說明：{extra.caption}"
        images = extra.images or images
    payload = {
        "id": str(m.id),
        "authorId": uid,
        "author": item.author or username,
        "text": text,
        "timestamp": m.timestamp.isoformat(),
        "fromSelf": bool(m.is_sent_by_viewer),
    }
    if full_name and not item.author:
        payload["authorName"] = full_name
    if m.reply is not None:
        payload["replyToId"] = str(m.reply.id)
    if images:
        payload["images"] = images
    return payload


def load_config() -> dict:
    url = os.environ.get("MINISAGO_INSTAGRAM_BRIDGE_URL")
    secret = os.environ.get("MINISAGO_INSTAGRAM_BRIDGE_SECRET")
    if url and secret:
        return {"url": url, "secret": secret}
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def ask_nino(config: dict, body: dict) -> dict:
    r = requests.post(
        config["url"],
        json=body,
        headers={"authorization": f"Bearer {config['secret']}"},
        timeout=REQUEST_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"core 回應 {r.status_code}: {r.text.strip()[:200]}")
    return r.json()


def mentions_anyone(m: DirectMessage) -> bool:
    return m.text is not None and "@" in m.text


def main(thread_id: str) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    config = load_config()
    cl = Client()
    cl.load_settings(SESSION)
    # instagrapi 預設每個請求前都隨機等，一輪就累積好幾秒；
    # 刻意的停頓只留在別人看得到的動作（已讀、表情、回覆）上
    cl.delay_range = []

    me = cl.account_info().username
    mention = f"@{me}".lower()

    thread = cl.direct_thread(thread_id, amount=1)
    users = {str(u.pk): (u.username, u.full_name or "") for u in thread.users}
    users[str(cl.user_id)] = (me, "")

    seen = {m.id for m in cl.direct_messages(thread_id, amount=HISTORY)}
    last_seq = inbox_seq(cl)
    last_reply_at = 0.0
    last_activity = 0.0
    # 她剛回完誰：(user_id, 到期時間)。下一則任何人的訊息都會把它用掉
    conversation: tuple[str, float] | None = None
    print(f"以 @{me} 監聽「{thread.thread_title}」；已略過 {len(seen)} 則舊訊息")

    while True:
        active = time.time() - last_activity < ACTIVE_WINDOW
        time.sleep(random.uniform(*(POLL_ACTIVE if active else POLL_IDLE)))
        try:
            seq = inbox_seq(cl)
            if seq == last_seq:
                continue
            last_seq = seq
            messages = cl.direct_messages(thread_id, amount=HISTORY)
        except Exception as e:
            print(f"!! 讀取失敗：{type(e).__name__}: {e}")
            continue

        history = list(reversed(messages))  # 舊到新
        for m in history:
            if m.id in seen:
                continue
            seen.add(m.id)
            if m.is_sent_by_viewer:
                continue
            last_activity = time.time()
            uid = str(m.user_id)
            item = describe(m)
            who = item.author or users.get(uid, (uid, ""))[0]
            print(f"{m.timestamp:%H:%M:%S} {who}: {item.text}")

            if m.text is not None and mention in m.text.lower():
                mode = "mention"
            elif m.reply is not None and bool(m.reply.is_sent_by_viewer):
                mode = "reply"
            elif (
                conversation is not None
                and conversation[0] == uid
                and time.time() < conversation[1]
                and not mentions_anyone(m)
            ):
                mode = "continuation"
            else:
                mode = None
            conversation = None  # 跟 Discord 一樣：中間有任何人講話，延續就結束
            if mode is None:
                continue

            wait = COOLDOWN_SECONDS - (time.time() - last_reply_at)
            if wait > 0:
                time.sleep(wait)  # 冷卻中被叫就等一下再回，不跳過

            # 只送到這則為止的訊息，避免她看到「未來」的內容
            upto = history[: history.index(m) + 1]
            # 分享的貼文 / Reels 只有封面；每張照片和 Reels 說明要多打一個請求，
            # 只抓她要回的那則和它回覆的那則，其餘歷史訊息只給封面
            focus = {str(m.id)} | ({str(m.reply.id)} if m.reply is not None else set())
            shared = {}
            for x in upto:
                url = describe(x).share_url
                if str(x.id) in focus and url:
                    extra = shared_media(cl, url)
                    if extra is not None:
                        shared[str(x.id)] = extra
            body = {
                "threadId": thread_id,
                "threadTitle": thread.thread_title or "",
                "requestMessageId": str(m.id),
                "addressingMode": mode,
                "messages": [to_payload(x, users, me, shared) for x in upto],
            }
            # IG 的「輸入中」要走即時連線，instagrapi 做不到；先標已讀，
            # 群組會馬上看到她「看到了」，接著才是回覆，等待比較不像當機。
            time.sleep(random.uniform(*SEEN_DELAY))
            try:
                cl.direct_message_seen(int(thread_id), m.id)
            except Exception as e:
                print(f"!! 標已讀失敗（不影響回覆）：{type(e).__name__}: {e}")

            started = time.time()
            try:
                answer = ask_nino(config, body)
            except Exception as e:
                print(f"!! 問二乃失敗：{type(e).__name__}: {e}")
                continue
            print(f"   ({mode}，二乃想了 {time.time() - started:.1f} 秒)")
            reply, reaction = answer.get("reply"), answer.get("reaction")
            if not reply and not reaction:
                print("   (她決定不理)")
                continue

            if reaction:
                try:
                    cl.direct_send_reaction(int(thread_id), int(m.id), reaction)
                    print(f"   -> 表情：{reaction}")
                except Exception as e:
                    print(f"!! 按表情失敗：{type(e).__name__}: {e}")
            if not reply:
                continue

            time.sleep(random.uniform(*TYPING_DELAY))
            try:
                sent = cl.direct_send(reply, thread_ids=[int(thread_id)], reply_to_message=m)
                seen.add(sent.id)
                last_reply_at = time.time()
                conversation = (uid, time.time() + CONTINUATION_SECONDS)
                print(f"   -> 回覆：{reply}")
            except Exception as e:
                print(f"!! 發送失敗：{type(e).__name__}: {e}")

        cl.dump_settings(SESSION)


if __name__ == "__main__":
    thread_id = sys.argv[1] if len(sys.argv) == 2 else os.environ.get("IG_THREAD_ID")
    if not thread_id:
        sys.exit("用法：python nino.py <thread_id>（或設定 IG_THREAD_ID）")
    try:
        main(thread_id)
    except KeyboardInterrupt:
        print("\n結束")
    except Exception:
        traceback.print_exc()
        print(f"!! 程式中止，{CRASH_BACKOFF_SECONDS} 秒後結束讓 docker 重啟", flush=True)
        time.sleep(CRASH_BACKOFF_SECONDS)
        sys.exit(1)
