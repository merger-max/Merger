/**
 * اختبار HTTP كامل ضد خادم التطوير:
 *  إنشاء مهمة من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع)
 *  → حذف → 404 → JSON تالف → قائمة فارغة
 * الاستخدام: ابدأ الخادم أولًا: node scripts/dev-server.js 3001
 *            ثم: node scripts/test-http.js [baseUrl]
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawnSync } = require("child_process");

const BASE = process.argv[2] || "http://localhost:3001";
const results = [];

function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

async function jsonFetch(pathname, opts) {
  const r = await fetch(BASE + pathname, opts);
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: r.status, body, headers: r.headers };
}

/* توليد فيديو اختبار صغير بـ ffmpeg النظام أو ffmpeg-static */
function makeSampleVideo(dest, size, dur, withAudio) {
  const ffmpegPath = (() => {
    try { return require("ffmpeg-static"); } catch { return "ffmpeg"; }
  })();
  const args = [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30:duration=${dur}`,
    ...(withAudio ? ["-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(withAudio ? ["-c:a", "aac"] : []),
    dest,
  ];
  const r = spawnSync(ffmpegPath, args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + r.stderr.slice(-200));
}

async function serveLocalFile(filePath) {
  // خادم محلي مؤقت يخدم الملف للروابط المباشرة
  const http = require("http");
  const buf = fs.readFileSync(filePath);
  const srv = http.createServer((rq, rs) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(rq.headers.range || "");
    if (range) {
      const total = buf.length;
      let start = range[1] === "" ? total - Number(range[2]) : Number(range[1]);
      let end = range[2] === "" ? total - 1 : Number(range[2]);
      start = Math.max(0, Math.min(start, total - 1));
      end = Math.max(start, Math.min(end, total - 1));
      rs.writeHead(206, {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
      });
      rs.end(buf.subarray(start, end + 1));
      return;
    }
    rs.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(buf.length) });
    rs.end(buf);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { url: `http://127.0.0.1:${port}/clip.mp4`, close: () => srv.close() };
}

async function main() {
  console.log("🧪 اختبار HTTP كامل ضد", BASE);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));

  /* تجهيز مقطعين مختلفي الدقة وخدمتهما محليًا */
  const clipA = path.join(tmp, "a_320x240.mp4");
  const clipB = path.join(tmp, "b_640x360.mp4");
  makeSampleVideo(clipA, "320x240", 2, true);
  makeSampleVideo(clipB, "640x360", 2, false);
  const srvA = await serveLocalFile(clipA);
  const srvB = await serveLocalFile(clipB);

  /* 1) إنشاء مهمة من روابط */
  const create = await jsonFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [srvA.url, srvB.url] }),
  });
  check("إنشاء مهمة من روابط (201)", create.status === 201 && create.body.jobId);
  const jobId = create.body.jobId;

  /* 2) تنفيذ الدمج */
  const proc = await jsonFetch(`/api/jobs/${jobId}/process`, { method: "POST" });
  check("تنفيذ الدمج (200 status=done)", proc.status === 200 && proc.body.status === "done", `HTTP ${proc.status}`);
  check("الدقة = أكبر دقة مدخل", proc.body.resolution === "640x360", proc.body.resolution);
  check("المدة ≈ 4 ثوانٍ", Math.abs(proc.body.duration - 4) < 1, String(proc.body.duration));

  /* 3) بث الناتج مع Range → 206 */
  const range = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-1023" } });
  check("بث الفيديو يدعم Range (206)", range.status === 206);
  check("ترويسة Content-Range صحيحة", (range.headers.get("content-range") || "").endsWith(`/${proc.body.size}`), range.headers.get("content-range"));
  const partBuf = Buffer.from(await range.arrayBuffer());
  check("طول الجزء = 1024 بايت", partBuf.length === 1024);
  const full = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const fullBuf = Buffer.from(await full.arrayBuffer());
  check("البث الكامل يطابق الحجم", fullBuf.length === proc.body.size);
  const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
  check("download=1 يعطي ترويسة إرفاق", /attachment/.test(dl.headers.get("content-disposition") || ""));

  /* 4) مهمة مختلطة (رابط + ملف مرفوع) — رفع بأجزاء 4MB */
  const mixed = await jsonFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { kind: "url", url: srvA.url },
        { kind: "file", name: "b.mp4", size: fs.statSync(clipB).size, mime: "video/mp4" },
      ],
    }),
  });
  check("إنشاء مهمة مختلطة (201 uploading)", mixed.status === 201 && mixed.body.status === "uploading");
  const jobId2 = mixed.body.jobId;
  const chunkBytes = mixed.body.uploadChunkBytes;
  const fileBuf = fs.readFileSync(clipB);
  let upAll = true;
  for (let k = 0; k < Math.ceil(fileBuf.length / chunkBytes); k++) {
    const up = await fetch(`${BASE}/api/upload?job=${jobId2}&seq=1&chunk=${k}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: fileBuf.subarray(k * chunkBytes, (k + 1) * chunkBytes),
    });
    if (up.status !== 200) upAll = false;
  }
  check("رفع أجزاء الملف (كل الأجزاء 200)", upAll);
  const proc2 = await jsonFetch(`/api/jobs/${jobId2}/process`, { method: "POST" });
  check("دمج المهمة المختلطة (done)", proc2.status === 200 && proc2.body.status === "done", `HTTP ${proc2.status} ${JSON.stringify(proc2.body).slice(0, 120)}`);

  /* 5) حذف ثم 404 */
  const del = await jsonFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  check("حذف فوري شامل (200)", del.status === 200 && del.body.ok === true);
  const afterDel = await jsonFetch(`/api/jobs/${jobId}`);
  check("الاستعلام بعد الحذف (404)", afterDel.status === 404);
  const afterDelProc = await jsonFetch(`/api/jobs/${jobId}/process`, { method: "POST" });
  check("process بعد الحذف (404)", afterDelProc.status === 404);

  /* 6) JSON تالف → 400 */
  const bad = await fetch(BASE + "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{这不是JSON",
  });
  check("JSON تالف → 400 برسالة عربية", bad.status === 400);
  const badBody = await bad.json();
  check("رسالة الخطأ بصيغة error", Boolean(badBody.error));

  /* 7) قائمة فارغة (بعد الحذف) */
  const list = await jsonFetch("/api/jobs");
  const remaining = (list.body.jobs || []).filter((j) => j.jobId === jobId);
  check("القائمة لا تحوي المهمة المحذوفة", remaining.length === 0);

  /* 8) رفض مقطع واحد وحد المصادر */
  const one = await jsonFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [srvA.url] }),
  });
  check("رفض مقطع واحد (400)", one.status === 400);
  const tooMany = await jsonFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: Array.from({ length: 11 }, () => srvA.url) }),
  });
  check("رفض 11 مقطعًا (400)", tooMany.status === 400);

  /* تنظيف المهام المتبقية */
  await jsonFetch(`/api/jobs/${jobId2}`, { method: "DELETE" });
  srvA.close(); srvB.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nالنتيجة: ${passed}/${results.length} اختبار HTTP ناجح`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error("❌ فشل الاختبار:", e);
  process.exit(1);
});
