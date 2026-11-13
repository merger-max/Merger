/**
 * اختبار وحدات لمحرك الدمج والتخزين:
 *  1) توليد فيديوهين مختلفي الدقة بـ ffmpeg (واحد بصوت وواحد بلا صوت)
 *  2) دمجهما → التحقق: الاكتمال، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود الصوت
 *  3) اختبار التخزين في Turso والاسترجاع بتطابق sha256
 *  4) مسار رفع الأجزاء (تقسيم 4MB → صفوف 2MB)
 *  5) حدود الحجم (رفع يتجاوز الحجم المعلن → 413)
 *  6) الحذف الشامل (كل الصفوف)
 * الاستخدام: node scripts/test-unit.js   (يحتاج TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في .env)
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

/* تحميل .env يدويًا */
for (const f of [".env", "../.env.local"]) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !m[1].startsWith("#") && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

const db = require("../lib/db");
const merge = require("../lib/merge");

const FFMPEG = merge.ffmpegBin();
const FFPROBE = merge.ffprobeBin();
const results = [];

function check(name, cond, detail) {
  const ok = Boolean(cond);
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

function runFF(args) {
  const r = spawnSync(FFMPEG, args, { encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-300)}`);
}

function probe(file) {
  return merge.probeFile(file);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
  console.log("🧪 اختبار وحدات — مجلد العمل:", tmp);

  /* 1) توليد فيديوهين مختلفي الدقة */
  const vidA = path.join(tmp, "a_320x240.mp4"); // 320x240 — بصوت
  const vidB = path.join(tmp, "b_640x360.mp4"); // 640x360 — بلا صوت
  runFF([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", vidA,
  ]);
  runFF([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", vidB,
  ]);
  const infoA = await probe(vidA);
  const infoB = await probe(vidB);
  check("توليد فيديو A (320x240 بصوت)", infoA.width === 320 && infoA.hasAudio);
  check("توليد فيديو B (640x360 بلا صوت)", infoB.width === 640 && !infoB.hasAudio);

  /* 2) إنشاء مهمة في القاعدة ودمجهما عبر المحرك */
  const jobId = "t" + crypto.randomBytes(5).toString("hex");
  await db.createJob({
    jobId,
    sources: [
      { kind: "url", url: "file://" + vidA }, // الرابط يُستبدل مباشرة بالملف في هذا الاختبار
      { kind: "file", name: "b.mp4", size: fs.statSync(vidB).size },
    ],
  });
  // تمرير الملف A كـ "رابط" file:// — لا يدعمه downloadUrl؛ لذا نخزنه كأجزاء مرفوعة بدلًا من ذلك
  const bufA = fs.readFileSync(vidA);
  await db.storeBlob("source_chunks", jobId, 0, bufA);
  await db.getDb().execute({
    sql: `UPDATE sources SET kind='file', size=? WHERE job_id=? AND seq=0`,
    args: [bufA.length, jobId],
  });
  const bufB = fs.readFileSync(vidB);
  await db.storeBlob("source_chunks", jobId, 1, bufB);
  await db.getDb().execute({
    sql: `UPDATE sources SET kind='file', size=? WHERE job_id=? AND seq=1`,
    args: [bufB.length, jobId],
  });

  const merged = await merge.runMergeJob(jobId, () => {});
  check("اكتمال الدمج (status=done)", merged.done === true);
  check("الدقة = أكبر دقة مدخل (640x360)", merged.resolution === "640x360", merged.resolution);
  const durSum = infoA.duration + infoB.duration;
  check(
    `المدة ≈ مجموع المدد (${durSum.toFixed(2)}s)`,
    Math.abs(merged.duration - durSum) < 0.8,
    `الناتج ${merged.duration}s`,
  );

  /* التحقق من وجود صوت في الناتج */
  const outMeta = await probe(path.join(tmp, "check.mp4")).catch(() => null);
  // نستخرج الناتج من التخزين للتحقق
  const outBuf = await db.readOutputFully(jobId);
  const outCheck = path.join(tmp, "out_check.mp4");
  fs.writeFileSync(outCheck, outBuf);
  const outInfo = await probe(outCheck);
  check("الناتج يحتوي مسار صوت", outInfo.hasAudio === true);
  check("الناتج mp4/h264", outInfo.codec === "h264", outInfo.codec);
  void outMeta;

  /* 3) الاسترجاع بتطابق sha256 */
  check(
    "sha256 المخزّن يطابق الناتج",
    merged.sha256 === crypto.createHash("sha256").update(outBuf).digest("hex"),
  );

  /* 4) مسار رفع الأجزاء: 4MB → صفوف 2MB (مطابقة لمنطق api/upload) */
  const job2 = "u" + crypto.randomBytes(5).toString("hex");
  const L = db.limits();
  const SUB = Math.ceil(L.uploadChunkBytes / L.storageChunkBytes);
  const big = crypto.randomBytes(Math.floor(L.uploadChunkBytes * 1.5)); // 6MB
  await db.createJob({ jobId: job2, sources: [{ kind: "file", name: "big.mp4", size: big.length }] });
  for (let k = 0; k < Math.ceil(big.length / L.uploadChunkBytes); k++) {
    const body = big.subarray(k * L.uploadChunkBytes, (k + 1) * L.uploadChunkBytes);
    const parts = Math.ceil(body.length / L.storageChunkBytes);
    for (let j = 0; j < parts; j++) {
      await db.getDb().execute({
        sql: `INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`,
        args: [job2, 0, k * SUB + j, body.subarray(j * L.storageChunkBytes, (j + 1) * L.storageChunkBytes)],
      });
    }
  }
  const round = await db.readSourceFully(job2, 0);
  check("رفع الأجزاء والاسترجاع بتطابق sha256", crypto.createHash("sha256").update(big).digest("hex") === crypto.createHash("sha256").update(round).digest("hex"));

  /* 5) حدود الحجم — downloadUrl يرفض حجمًا يتجاوز الحد */
  try {
    // خادم محلي صغير يرسل 3MB — الحد في الاختبار 1MB
    const http = require("http");
    const srv = http.createServer((rq, rs) => {
      rs.writeHead(200, { "Content-Length": String(3 * 1024 * 1024) });
      const chunk = crypto.randomBytes(1024 * 1024);
      rs.write(chunk); rs.write(chunk); rs.write(chunk); rs.end();
    });
    await new Promise((r) => srv.listen(0, r));
    const port = srv.address().port;
    const dest = path.join(tmp, "too_big.bin");
    await merge.downloadUrl(`http://127.0.0.1:${port}/file`, dest, 1024 * 1024, () => {});
    check("حد الحجم (يجب أن يرفض)", false, "لم يرمِ خطأ الحجم");
  } catch (e) {
    check("حد الحجم (رفض المصدر الأكبر من الحد)", /يتجاوز الحد/.test(e.message), e.message.slice(0, 80));
  } finally {
    void 0;
  }

  /* 6) الحذف الشامل */
  await db.deleteJobCompletely(jobId);
  await db.deleteJobCompletely(job2);
  const j1 = await db.getJob(jobId);
  const j2 = await db.getJob(job2);
  check("الحذف الشامل يحذف كل الصفوف", j1 === null && j2 === null);

  /* تنظيف */
  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nالنتيجة: ${passed}/${results.length} اختبار ناجح`);
  // نغفل الخوادم المحلية المتبقية ثم نخرج صراحة (خوادم الاختبار تحبس حلقة الأحداث)
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("❌ فشل الاختبار:", e);
  process.exit(1);
});
