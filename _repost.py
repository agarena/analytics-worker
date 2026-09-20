# -*- coding: utf-8 -*-
import io, json, base64, sys, urllib.request
sys.stdout.reconfigure(encoding="utf-8")
KEY = [l.split("=", 1)[1].strip() for l in io.open(r"analytics-worker\.env", encoding="utf-8") if l.startswith("ADMIN_TOKEN=")][0]
from PIL import Image
img = Image.open(r"C:\Users\38221\Desktop\myprojects\web\表情包网站\assets\sticker-02.png")
img.thumbnail((1080, 1080))
for q in (80, 65, 50):
    buf = io.BytesIO(); img.save(buf, "JPEG", quality=q)
    if buf.tell() <= 200 * 1024: break
body = {"title": "豆包型人格：做事瞎糊弄", "characters": ["doubao"], "tags": ["搞笑"],
        "img": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()}
req = urllib.request.Request("https://api.agarena.xyz/api/stickers/submit", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}, method="POST")
r = json.load(urllib.request.urlopen(req, timeout=30))
print("重投:", r)
pid = r["id"]
req = urllib.request.Request("https://api.agarena.xyz/api/admin/sticker?key=" + KEY,
                             data=json.dumps({"id": pid, "action": "publish"}).encode(),
                             headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"}, method="POST")
print("上架:", json.load(urllib.request.urlopen(req, timeout=30)))
