"""把一則 IG 私訊解讀成二乃看得懂的東西：文字、附圖、作者。

IG 的訊息種類很多，而且多數沒有 text。這裡集中處理「每一種長什麼樣」，
nino.py 只管什麼時候回、怎麼回。新增一種訊息類型只要改這個檔案。

實測過的格式（2026-09-24，同一個群組最近 200 則）：
- media：照片 / 影片，m.media.thumbnail_url
- xma_clip：分享的 Reels，raw_xma["xma_clip"][0] 有封面、作者、連結，沒有貼文說明
- xma_media_share：分享的貼文，title_text＝「作者 說明全文」，只有封面一張；
  多圖貼文的每一張要另外打 media_info 才拿得到
- generic_xma 排版 27：Meta AI 的回覆，文字在 unified_response.sections
- generic_xma 且 sticker_type=cutout_sticker：貼圖
- raven_media：閱後即焚照片，刻意不給她看
"""

from dataclasses import dataclass, field

from instagrapi import Client
from instagrapi.types import DirectMessage

META_AI = "Meta AI"
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_SHARED_IMAGES = 10     # worker 一次最多看 10 個附件
CAPTION_LIMIT = 800

PLACEHOLDERS = {
    "media": "[傳了一張照片或影片]",
    "raven_media": "[傳了一張限時照片]",
    "voice_media": "[傳了一段語音]",
    "animated_media": "[傳了一張 GIF]",
    "clip": "[分享了一則 Reels]",
    "xma_clip": "[分享了一則 Reels]",
    "xma_media_share": "[分享了一則貼文]",
    "media_share": "[分享了一則貼文]",
    "xma_share": "[分享了一則貼文或連結]",
    "generic_xma": "[分享了一則貼文或連結]",
    "story_share": "[分享了一則限時動態]",
    "reel_share": "[回覆了一則限時動態]",
    "action_log": "[群組動態]",
    "like": "[按了愛心]",
}


@dataclass
class Item:
    text: str
    images: list[dict] = field(default_factory=list)
    author: str | None = None      # 不是群組成員說的話（例如 Meta AI）才覆寫
    share_url: str | None = None   # 分享的 Reels / 貼文；她要回的那則才去抓完整內容


def _image(url: object, mime: object = "image/jpeg") -> list[dict]:
    if not url:
        return []
    content_type = str(mime or "image/jpeg").lower()
    return [{"url": str(url), "contentType": content_type if content_type in IMAGE_TYPES else "image/jpeg"}]


def _xma(m: DirectMessage) -> dict:
    """raw_xma 的形狀是 {類型: [卡片, ...]}，取第一張卡片。"""
    for cards in (m.raw_xma or {}).values():
        if isinstance(cards, list) and cards and isinstance(cards[0], dict):
            return cards[0]
    return {}


def _meta_ai_text(card: dict) -> str:
    sections = ((card.get("unified_response") or {}).get("sections")) or []
    parts = []
    for section in sections:
        primitive = ((section or {}).get("view_model") or {}).get("primitive") or {}
        if isinstance(primitive.get("text"), str):
            parts.append(primitive["text"])
    return "\n".join(parts).strip()


def describe(m: DirectMessage) -> Item:
    if m.text:
        return Item(m.text)
    kind = m.item_type or ""
    placeholder = PLACEHOLDERS.get(kind, f"[{kind}]")

    if kind == "media" and m.media is not None:
        return Item(placeholder, _image(m.media.thumbnail_url))

    if kind in ("xma_clip", "xma_share", "clip", "media_share", "xma_media_share"):
        card = _xma(m)
        author = card.get("header_title_text")
        target = card.get("target_url")
        what = "Reels" if kind in ("xma_clip", "clip") else "貼文"
        text = f"[分享了 @{author} 的{what}]" if author else placeholder
        if target:
            text += f" {target}"
        # 貼文的 title_text 是「作者 說明全文」，說明直接就有，不用另外抓
        title = card.get("title_text") or ""
        if author and title.startswith(f"{author} "):
            title = title[len(author) + 1:]
        if title.strip():
            text += f"\n貼文說明：{_clip(title)}"
        return Item(text, _image(card.get("preview_url"), card.get("preview_url_mime_type")), share_url=target)

    if kind == "generic_xma":
        card = _xma(m)
        ai_text = _meta_ai_text(card)
        if ai_text:
            return Item(ai_text, author=META_AI)
        if card.get("sticker_type") == "cutout_sticker":
            return Item("[傳了一張貼圖]", _image(card.get("preview_url"), card.get("preview_url_mime_type")))
        title = card.get("title_text") or card.get("caption_body_text")
        target = card.get("target_url")
        text = "[分享了一則連結]" + (f" {title}" if title else "") + (f" {target}" if target else "")
        return Item(text, _image(card.get("preview_url"), card.get("preview_url_mime_type")))

    # raven_media（閱後即焚）刻意只給文字：傳的人本來就只想讓人看一次
    return Item(placeholder)


def _clip(text: str) -> str:
    text = text.strip()
    return text if len(text) <= CAPTION_LIMIT else text[:CAPTION_LIMIT] + "…"


@dataclass
class Shared:
    caption: str | None
    images: list[dict]


def shared_media(cl: Client, url: str) -> Shared | None:
    """分享卡片只有封面；多圖貼文的每一張和 Reels 的說明要多打一個請求。
    只在她要回的那則（或它回覆的那則）才抓。"""
    try:
        media = cl.media_info(cl.media_pk_from_url(url))
    except Exception as e:
        print(f"   (抓分享內容失敗，只給封面：{type(e).__name__})")
        return None
    urls = [r.thumbnail_url for r in media.resources if r.thumbnail_url] or [media.thumbnail_url]
    images = [img for u in urls[:MAX_SHARED_IMAGES] for img in _image(u)]
    caption = (media.caption_text or "").strip()
    return Shared(_clip(caption) if caption else None, images)
