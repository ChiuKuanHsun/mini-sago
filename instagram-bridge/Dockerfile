# 二乃的 IG 轉接程式。只有這個容器走宿舍 VPN 出去，見 compose.instagram.yaml。
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY nino.py ig_items.py listen.py login.py ./

# 非 root；實際 uid 由 compose 的 user: 對齊 host，bind mount 的 session.json 才寫得回去
USER 1000:1000
ENTRYPOINT ["python", "nino.py"]
