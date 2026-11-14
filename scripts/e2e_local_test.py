"""
اختبار شامل محلي (E2E) بنسخة مطابقة للإنتاج:
1) إضافة مفتاح Cloudflare عبر API المفاتيح الرسمي (POST /api/keys)
2) قراءة القائمة والتأكد من التقنيع
3) مصافحة MCP (initialize) ثم استدعاء generate_image بموديل flux-1-schnell
4) التحقق من تسجيل المهمة في قاعدة Turso عبر GET /api/tasks
5) استخراج الصورة الناتجة وحفظها في download/
المفتاح يُقرأ من متغير البيئة CF_TEST_KEY فقط — لا يُخزَّن في أي ملف.
"""
import base64
import json
import os
import sys
import urllib.request

BASE = "http://localhost:3111"
MCP_TOKEN = "local-e2e-token-123"  # توكن اختبار محلي من اختراعي — ليس سرًا
OUT_DIR = "/home/z/my-project/download"


def raw_post(path: str, body: dict, headers: dict | None = None, timeout: int = 170) -> str:
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()


def parse_rpc(raw: str, wanted_id: int) -> dict:
    """يقبل رد JSON صافٍ أو مجرى SSE ويستخرج الرسالة المطلوبة."""
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict) and ("result" in obj or "error" in obj):
            return obj
    except json.JSONDecodeError:
        pass
    for line in raw.splitlines():
        if line.startswith("data:"):
            payload = line[5:].strip()
            if not payload:
                continue
            try:
                obj = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == wanted_id and ("result" in obj or "error" in obj):
                return obj
    raise RuntimeError(f"لم أجد ردًا بالمعرف {wanted_id} — أول 300 حرف: {raw[:300]}")


def main() -> None:
    key = os.environ.get("CF_TEST_KEY", "")
    if ":" not in key:
        print("✗ CF_TEST_KEY مفقود/خاطئ (المطلوب account_id:token)")
        sys.exit(1)

    # 1) إضافة المفتاح عبر الواجهة الرسمية — نفس ما تفعله لوحة الإدارة تمامًا
    r1 = json.loads(raw_post("/api/keys", {
        "provider": "cloudflare",
        "api_key": key,
        "label": "Cloudflare الأساسي (اختبار E2E)",
    }))
    k = r1.get("key") or {}
    print(f"1) إضافة المفتاح: masked={k.get('maskedKey')} | status={k.get('status')} | provider={k.get('provider')}")

    # 2) القائمة — التأكد أن المفتاح ظهر مقنَّعًا
    with urllib.request.urlopen(BASE + "/api/keys", timeout=30) as resp:
        keys = json.loads(resp.read())["keys"]
    cf = [x for x in keys if x["provider"] == "cloudflare"]
    print(f"2) عدد المفاتيح الكلي: {len(keys)} | مفاتيح cloudflare: {len(cf)} | أولها: {cf[0]['maskedKey'] if cf else '—'}")

    # 3) مصافحة MCP
    H = {"Authorization": f"Bearer {MCP_TOKEN}", "Accept": "application/json, text/event-stream"}
    init_raw = raw_post("/mcp", {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "e2e-test", "version": "1.0"},
        },
    }, H, timeout=120)
    init = parse_rpc(init_raw, 1)
    if "error" in init:
        print("✗ فشلت المصافحة:", init["error"]); sys.exit(1)
    si = init["result"]["serverInfo"]
    print(f"3) MCP متصل: {si['name']} v{si['version']}")
    raw_post("/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, H, timeout=30)

    # 4) توليد صورة عبر generate_image
    call = parse_rpc(raw_post("/mcp", {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {
            "name": "generate_image",
            "arguments": {
                "prompt": "A cozy old-town Arabic coffee shop at dusk, warm lantern light, cinematic",
                "model": "flux-1-schnell",
                "wait_seconds": 90,
            },
        },
    }, H), 2)
    if "error" in call:
        print("✗ خطأ RPC:", call["error"]); sys.exit(1)
    text = call["result"]["content"][0]["text"]
    print(f"4) رد generate_image: isError={call['result'].get('isError', False)} | الطول={len(text)}")
    print(f"   بداية الرد: {text[:160].replace(chr(10), ' · ')}")

    # 5) التحقق من قاعدة البيانات
    with urllib.request.urlopen(BASE + "/api/tasks?limit=3", timeout=30) as resp:
        t = json.loads(resp.read())
    task = t["tasks"][0] if t["tasks"] else None
    if not task:
        print("✗ لا توجد مهام في القاعدة!"); sys.exit(1)
    print(f"5) أحدث مهمة: status={task['status']} | provider={task['provider']} | model={task['model']} | urls={len(task['urls'])}")
    print(f"   الإحصائيات: {t['stats']}")

    # 6) استخراج الصورة وحفظها
    urls = task["urls"]
    if urls and urls[0].startswith("data:image/"):
        raw = base64.b64decode(urls[0].split(",", 1)[1])
        ext = "png" if raw[:2] == b"\x89P" else "jpg" if raw[:2] == b"\xff\xd8" else "bin"
        out = os.path.join(OUT_DIR, f"e2e-local-image.{ext}")
        with open(out, "wb") as f:
            f.write(raw)
        print(f"6) ✓ الصورة محفوظة: {out} ({len(raw)//1024}KB، الصيغة الفعلية {ext.upper()})")
    else:
        print(f"6) الروابط المخزنة: {[u[:100] for u in urls]}")


if __name__ == "__main__":
    main()
