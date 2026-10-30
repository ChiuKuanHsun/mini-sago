"""接上 MiniSago：有人叫二乃時，把群組最近的訊息送給 VM 上的 core，由她本人回覆或按表情。

不管有沒有叫她，每一則新訊息（包括她自己的）都會送到 core 的 /instagram-observe 存起來，
被叫的時候 core 才看得到比 IG 一次給的 20 則更早的前文。啟動時會先補送最近 BACKFILL 則。

已讀：被叫時 1 秒內已讀再回；沒叫她的訊息則像真人偶爾滑過去看（見 GLANCE_*），
不會每則秒讀，也不會一直掛著未讀。

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

from ig_items import META_AI, Shared, describe, shared_media
from listen import inbox_seq

HERE = Path(__file__).parent
SESSION = Path(os.environ.get("IG_SESSION_FILE") or HERE / "session.json")
CONFIG = HERE / "bridge.json"
# 當掉後 docker 會自動重啟；先睡一段再結束，避免 session 失效時一直重新連 IG 觸發風控
CRASH_BACKOFF_SECONDS = 300
HISTORY = 20               # 每次送給二乃的最近訊息數
COOLDOWN_SECONDS = 5       # 兩次回覆至少間隔這麼久；模型本身要好幾秒，實際間隔會更長
SEEN_DELAY = (0.5, 1)      # 看到訊息後停一下才標已讀，秒讀也像機器
# 沒叫她的訊息：像真人偶爾滑過去看一眼，把當時最新那則標已讀（前面的一起算看過）。
# 從第一則未讀開始計時，後面的訊息不會延後它，大家一直聊她也會隔一陣子看一次。
GLANCE_ENGAGED = (20, 60)  # 她剛聊過（ENGAGED_WINDOW 內回過話），人還在群組裡
GLANCE_IDLE = (60, 180)
ENGAGED_WINDOW = 10 * 60
TYPING_DELAY = (0.5, 1)    # 模型本身就要好幾秒，這裡只補一點
CONTINUATION_SECONDS = 5 * 60
# 群組最近有人講話就查快一點，安靜時放慢，平常的請求量不會暴增
ACTIVE_WINDOW = 5 * 60
POLL_ACTIVE = (2, 4)
POLL_IDLE = (10, 20)
# seq_id 沒變也每隔這麼久讀一次訊息：序號來源被 IG 改過一次，萬一又不準，最多晚這麼久而不是完全不回
FORCE_READ_SECONDS = 60
REQUEST_TIMEOUT = 150      # core 那邊一則回答最久可能跑到 1-2 分鐘
BACKFILL = 100             # 啟動時補送給 core 存的訊息數；IG 一頁 20 則，等於多打幾個請求
OBSERVE_BATCH = 100        # = core 一次收的上限
OBSERVE_PENDING_LIMIT = 500  # core 連不上時先留著下輪再送，最多留這麼多
# instagrapi 打 IG 的請求不帶逾時（它的 request_timeout 只是兩個請求之間的間隔），
# 連線半開時會永遠等下去、整個輪詢停住（2026-10-29 卡了 31 小時）。（連線, 讀取）秒
IG_TIMEOUT = (10, 30)
# 她送出的「@Meta AI」要附上 commands 才叫得出它（App 點藍字時會帶，只打字不算；2026-10-30 實測）
META_AI_MENTION = "@Meta AI"
# 她最多連續叫 Meta AI 幾次；到了就只送純文字，Meta AI 再 @她也改成可以不回。有人叫她就重新算
META_AI_ROUNDS = 3


def to_payload(m: DirectMessage, users: dict[str, tuple[str, str]], me: str, my_id: str, shared: dict[str, Shared]) -> dict:
    uid = str(m.user_id)
    username, full_name = users.get(uid, (me, "") if uid == my_id else (uid, ""))
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
        "fromSelf": uid == my_id,
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


def observe(config: dict, thread_id: str, pending: list[dict]) -> None:
    """把還沒送出的訊息交給 core 存。core 連不上就留到下一輪；內容被拒（400）就丟掉，免得卡住後面的。"""
    url = config["url"].rsplit("/", 1)[0] + "/instagram-observe"
    while pending:
        batch = pending[:OBSERVE_BATCH]
        try:
            r = requests.post(
                url,
                json={"threadId": thread_id, "messages": batch},
                headers={"authorization": f"Bearer {config['secret']}"},
                timeout=30,
            )
        except Exception as e:
            print(f"!! 存聊天紀錄失敗，下輪再送：{type(e).__name__}: {e}")
            break
        if r.status_code == 400:
            print(f"!! core 不收這批聊天紀錄（{len(batch)} 則），略過：{r.text.strip()[:200]}")
        elif r.status_code != 200:
            print(f"!! 存聊天紀錄失敗，下輪再送：core 回應 {r.status_code}")
            break
        del pending[: len(batch)]
    del pending[:-OBSERVE_PENDING_LIMIT]


def observed(m: DirectMessage, users: dict[str, tuple[str, str]], me: str, my_id: str) -> dict:
    # 圖片網址幾天就過期，core 只存文字；不帶圖也避免一張怪網址讓整批被拒
    payload = to_payload(m, users, me, my_id, {})
    payload.pop("images", None)
    return payload


def bound_timeouts(session: requests.Session, timeout: tuple[float, float]) -> None:
    """沒指定 timeout 的請求一律用這個；逾時會丟例外，由迴圈裡現有的 except 接住、下一輪重試。"""
    request = session.request

    def bounded(method, url, **kwargs):
        if kwargs.get("timeout") is None:
            kwargs["timeout"] = timeout
        return request(method, url, **kwargs)

    session.request = bounded


def utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def send_reply(cl: Client, thread_id: str, text: str, reply_to: DirectMessage, summon_meta_ai: bool) -> bool:
    """送出回覆，回傳有沒有叫出 Meta AI。

    instagrapi 的 direct_send 只送文字，所以要叫 Meta AI 時自己組同一個請求、多帶 commands
    （type 5 = Meta AI，格式照 App 送出的訊息抄）。只標第一個 @Meta AI，跟 App 一次叫一次一樣。
    offset 用 UTF-16 長度算：中文實測跟字數一致，前面有 emoji 的情況還沒實測。
    """
    at = text.find(META_AI_MENTION)
    # 有網址時 instagrapi 改走 link 端點，那邊收不收 commands 沒測過，先照原本送
    if not summon_meta_ai or at < 0 or "http" in text:
        cl.direct_send(text, thread_ids=[int(thread_id)], reply_to_message=reply_to)
        return False
    token = cl.generate_mutation_token()
    data = {
        "action": "send_item",
        "is_x_transport_forward": "false",
        "send_silently": "false",
        "is_shh_mode": "0",
        "send_attribution": "message_button",
        "client_context": token,
        "device_id": cl.android_device_id,
        "mutation_token": token,
        "_uuid": cl.uuid,
        "btt_dual_send": "false",
        "nav_chain": (
            "1qT:feed_timeline:1,1qT:feed_timeline:2,1qT:feed_timeline:3,"
            "7Az:direct_inbox:4,7Az:direct_inbox:5,5rG:direct_thread:7"
        ),
        "is_ae_dual_send": "false",
        "offline_threading_id": token,
        "text": text,
        "thread_ids": json.dumps([int(thread_id)]),
        "replied_to_action_source": "swipe",
        "replied_to_item_id": reply_to.id,
        "replied_to_client_context": reply_to.client_context,
        "commands": json.dumps(
            [{"offset": utf16_len(text[:at]), "length": utf16_len(META_AI_MENTION), "user_or_thread_fbid": 0, "type": 5}]
        ),
    }
    cl.private_request("direct_v2/threads/broadcast/text/", data=cl.with_default_data(data), with_signature=False)
    return True


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
    bound_timeouts(cl.private, IG_TIMEOUT)
    bound_timeouts(cl.public, IG_TIMEOUT)

    me = cl.account_info().username
    mention = f"@{me}".lower()

    thread = cl.direct_thread(thread_id, amount=1)
    users = {str(u.pk): (u.username, u.full_name or "") for u in thread.users}
    users[str(cl.user_id)] = (me, "")
    my_id = str(cl.user_id)

    backlog = cl.direct_messages(thread_id, amount=BACKFILL)
    seen = {m.id for m in backlog}
    pending = [observed(m, users, me, my_id) for m in reversed(backlog)]
    observe(config, thread_id, pending)
    last_seq = inbox_seq(cl)
    last_read = time.time()
    last_reply_at = 0.0
    last_activity = 0.0
    # 她剛回完誰：(user_id, 到期時間)。下一則任何人的訊息都會把它用掉
    conversation: tuple[str, float] | None = None
    # 她連續叫了 Meta AI 幾次
    meta_rounds = 0
    # 還沒已讀的最新一則，和她什麼時候會滑過去看
    unread: DirectMessage | None = None
    glance_at: float | None = None
    print(f"以 @{me} 監聽「{thread.thread_title}」；已略過 {len(seen)} 則舊訊息")

    while True:
        active = time.time() - last_activity < ACTIVE_WINDOW
        time.sleep(random.uniform(*(POLL_ACTIVE if active else POLL_IDLE)))
        if unread is not None and glance_at is not None and time.time() >= glance_at:
            try:
                cl.direct_message_seen(int(thread_id), unread.id)
                print(f"   (滑過去看了一眼，已讀到 {unread.timestamp:%H:%M:%S} 那則)")
            except Exception as e:
                print(f"!! 標已讀失敗：{type(e).__name__}: {e}")
            unread, glance_at = None, None
        try:
            seq = inbox_seq(cl)
            forced = seq == last_seq
            if forced and time.time() - last_read < FORCE_READ_SECONDS:
                continue
            last_seq = seq
            messages = cl.direct_messages(thread_id, amount=HISTORY)
            last_read = time.time()
        except Exception as e:
            print(f"!! 讀取失敗：{type(e).__name__}: {e}")
            continue

        history = list(reversed(messages))  # 舊到新
        if forced and any(m.id not in seen and str(m.user_id) != my_id for m in history):
            print("!! seq_id 沒變卻有新訊息：序號來源可能又不準了")
        # 先存再回：她回覆時 core 就已經有這一輪的訊息
        pending.extend(observed(m, users, me, my_id) for m in history if m.id not in seen)
        observe(config, thread_id, pending)
        for m in history:
            if m.id in seen:
                continue
            seen.add(m.id)
            # 她叫出來的 Meta AI 回覆，IG 也標成 is_sent_by_viewer（2026-10-30 實測），所以看 user_id
            if str(m.user_id) == my_id:
                continue
            last_activity = time.time()
            uid = str(m.user_id)
            item = describe(m)
            who = item.author or users.get(uid, (uid, ""))[0]
            print(f"{m.timestamp:%H:%M:%S} {who}: {item.text}")

            from_meta_ai = item.author == META_AI
            # Meta AI 的回覆沒有 m.text，文字在卡片裡；其他卡片（例如貼文說明）裡的 @ 不算叫她
            said = item.text if from_meta_ai else m.text
            if said is not None and mention in said.lower():
                mode = "mention"
            elif m.reply is not None and str(m.reply.user_id) == my_id:
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
            if mode is not None and not from_meta_ai:
                meta_rounds = 0  # 有人叫她，跟 Meta AI 的連續來回重新算
            elif mode == "mention" and meta_rounds >= META_AI_ROUNDS:
                mode = "reply"  # 跟 Meta AI 來回夠多次了：它再 @她，她可以不回
            if mode is None:
                unread = m
                if glance_at is None:
                    engaged = time.time() - last_reply_at < ENGAGED_WINDOW
                    glance_at = time.time() + random.uniform(*(GLANCE_ENGAGED if engaged else GLANCE_IDLE))
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
                "messages": [to_payload(x, users, me, my_id, shared) for x in upto],
            }
            # IG 的「輸入中」要走即時連線，instagrapi 做不到；先標已讀，
            # 群組會馬上看到她「看到了」，接著才是回覆，等待比較不像當機。
            time.sleep(random.uniform(*SEEN_DELAY))
            try:
                cl.direct_message_seen(int(thread_id), m.id)
            except Exception as e:
                print(f"!! 標已讀失敗（不影響回覆）：{type(e).__name__}: {e}")
            # 已讀到這則，前面排著要滑過去看的那次就不用了
            unread, glance_at = None, None

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
                # 不先標成看過：下一輪讀到她自己這則時會照常存進聊天紀錄，處理時再因為是她發的而略過
                if send_reply(cl, thread_id, reply, m, meta_rounds < META_AI_ROUNDS):
                    meta_rounds += 1
                    print(f"   (叫了 Meta AI，連續第 {meta_rounds} 次)")
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
