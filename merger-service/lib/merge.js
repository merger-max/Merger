/**
 * محرك الدمج — ffmpeg/ffprobe داخل الدالة نفسها.
 * توحيد كل المصادر: scale+pad إلى أكبر دقة بين المدخلات (حد 1920x1080 أبعاد زوجية)،
 * fps=30، setsar=1، format=yuv420p ثم concat=n=:v=1:a=1.
 * مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 * الترميز: libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 جودة عالية.
 * التقدم: قراءة out_time_us من -progress pipe:1 (0-40 سحب، 40-90 ترميز، 100 اكتمال).
 * لا نظام ملفات دائم — /tmp فقط ونظّفه في finally.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const db = require("./db");
const { limits } = require("./db");

/* ------------------------- تجهيز الثنائيات ------------------------- */

function resolveBin(pkgName, envVar) {
  // التجاوز بمتغير بيئة أولًا (اختبار محلي بـ ffmpeg النظام)
  if (envVar && process.env[envVar] && fs.existsSync(process.env[envVar])) {
    return process.env[envVar];
  }
  const mod = require(pkgName);
  return typeof mod === "string" ? mod : mod.path;
}

/** ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة — نسخة إلى /tmp بصلاحية 755 */
function ensureExecutable(srcPath) {
  const dest = path.join(os.tmpdir(), path.basename(srcPath));
  try {
    const st = fs.statSync(dest);
    if (st.size === fs.statSync(srcPath).size && (st.mode & 0o111) !== 0) {
      return dest;
    }
  } catch {
    /* غير موجود — نكمل النسخ */
  }
  fs.copyFileSync(srcPath, dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

function ffmpegBin() {
  return ensureExecutable(resolveBin("ffmpeg-static", "FFMPEG_PATH"));
}
function ffprobeBin() {
  return ensureExecutable(resolveBin("ffprobe-static", "FFPROBE_PATH"));
}

/* ------------------------- تشغيل أوامر ------------------------- */

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`timeout: ${path.basename(bin)} exceeded ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** ffprobe JSON لملف: الدقة، fps، المدة، وجود صوت */
async function probeFile(file) {
  const { code, stdout, stderr } = await run(
    ffprobeBin(),
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      file,
    ],
    60_000,
  );
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.slice(0, 300)}`);
  const info = JSON.parse(stdout);
  const video = (info.streams || []).find((s) => s.codec_type === "video");
  const audio = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("المصدر لا يحتوي مسار فيديو صالح");
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  const fps = evalFraction(video.avg_frame_rate) || evalFraction(video.r_frame_rate) || 30;
  const duration = parseFloat(info.format?.duration ?? video.duration ?? "0") || 0;
  return {
    width,
    height,
    fps: fps || 30,
    duration,
    hasAudio: Boolean(audio),
    codec: video.codec_name,
  };
}

function evalFraction(str) {
  if (!str || str === "0/0") return 0;
  const [a, b] = String(str).split("/").map(Number);
  if (!b) return a || 0;
  return a / b;
}

/* ------------------------- سحب المصادر ------------------------- */

/** تنزيل رابط مباشر إلى /tmp مع حد حجم مُرصّد أثناء التدفق */
async function downloadUrl(url, destPath, maxBytes, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length") || 0);
  if (total > maxBytes) throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
  const out = fs.createWriteStream(destPath);
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      out.destroy();
      reader.cancel();
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
    }
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once("drain", r));
    }
    if (onProgress && total) onProgress(received / total);
  }
  await new Promise((r) => out.end(r));
  return received;
}

/** تفريغ مصدر مرفوع (أجزاء في Turso) إلى /tmp */
async function materializeUploaded(jobId, seq, destPath) {
  const out = fs.createWriteStream(destPath);
  for await (const { buf } of db.iterateBlob("source_chunks", jobId, seq)) {
    if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
  return fs.statSync(destPath).size;
}

/* ------------------------- الدمج الكامل ------------------------- */

const DONE_WORDS = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);

/**
 * نفّذ الدمج كاملًا لمهمة موجودة — يكتب التقدم في القاعدة.
 * يعيد { done: true, ... } أو يرمي برسالة واضحة (فشل نهائي).
 */
async function runMergeJob(jobId, onProgressTick) {
  const L = limits();
  const job = await db.getJob(jobId);
  if (!job) throw new Error("المهمة غير موجودة");
  if (!job.sources.length) throw new Error("لا توجد مصادر لهذه المهمة");
  if (job.sources.length > L.maxSources) {
    throw new Error(`أقصى عدد مقاطع للدمج هو ${L.maxSources}`);
  }
  // حالة processing تُدار بآلية الاستحواذ في process.js (claimProcess) — لا نرفض هنا
  if (DONE_WORDS.has(String(job.status).toLowerCase())) throw new Error("تم الدمج مسبقًا");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId.slice(0, 8)}-`));
  const files = [];
  try {
    await db.patchJob(jobId, { status: "processing", progress: 2 });

    /* 0-40%: سحب المصادر وفتحها */
    let totalDuration = 0;
    const infos = [];
    for (let i = 0; i < job.sources.length; i++) {
      const s = job.sources[i];
      const file = path.join(tmpDir, `src_${i}.bin`);
      if (s.kind === "url") {
        if (!/^https?:\/\//i.test(s.url || "")) throw new Error(`رابط غير صالح: ${s.url}`);
        await downloadUrl(s.url, file, L.sourceMaxBytes, (p) =>
          onProgressTick(2 + Math.round((36 * (i + p)) / job.sources.length)),
        );
      } else {
        // ملف مرفوع — يجب أن تكون كل أجزاؤه مستلمة
        const size = await materializeUploaded(jobId, i, file);
        if (size > L.sourceMaxBytes) throw new Error(`حجم المصدر يتجاوز الحد المسموح`);
      }
      const sz = fs.statSync(file).size;
      if (sz === 0) throw new Error(`المصدر ${i + 1} فارغ`);
      const info = await probeFile(file);
      totalDuration += info.duration;
      if (totalDuration > L.maxTotalDurationSec) {
        throw new Error(`مجموع مدد المقاطع يتجاوز ${L.maxTotalDurationSec} ثانية`);
      }
      infos.push(info);
      files.push(file);
      await onProgressTick(2 + Math.round((38 * (i + 1)) / job.sources.length));
    }

    /* حساب الأبعاد الموحدة — أكبر دقة بين المدخلات بحد 1920x1080 وأبعاد زوجية */
    let W = Math.max(...infos.map((i) => i.width));
    let H = Math.max(...infos.map((i) => i.height));
    W = Math.min(1920, Math.max(2, W));
    H = Math.min(1080, Math.max(2, H));
    if (W % 2) W -= 1;
    if (H % 2) H -= 1;

    const outPath = path.join(tmpDir, "out.mp4");
    const filterParts = [];
    for (let i = 0; i < files.length; i++) {
      // فيديو موحد لكل مصدر
      filterParts.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`,
      );
      if (infos[i].hasAudio) {
        filterParts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        // مصدر بلا صوت → مسار صامت بنفس مدته (anullsrc لا يقبل duration — نقصه بـ atrim)
        filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=0:${infos[i].duration.toFixed(3)},asetpts=N/SR/TB[a${i}]`);
      }
    }
    // ترتيب مدخلات concat في ffmpeg 7: متداخل لكل مقطع [v0][a0][v1][a1] وليس كل الفيديو ثم كل الصوت
    const mapVA = files.map((_, i) => `[v${i}][a${i}]`).join("");
    filterParts.push(`${mapVA}concat=n=${files.length}:v=1:a=1[vout][aout]`);

    const args = [
      "-y",
      "-nostats",
      "-progress", "pipe:1",
      ...files.flatMap((f) => ["-i", f]),
      "-filter_complex", filterParts.join(";"),
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", L.ffmpegPreset,
      "-crf", "18",
      "-c:a", "aac",
      "-b:a", "192k",
      "-ar", "44100",
      "-movflags", "+faststart",
      outPath,
    ];

    /* 40-90%: الترميز مع قراءة التقدم الحي */
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let lastTick = 0;
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 280_000);
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.stdout.on("data", (d) => {
        // نقرأ out_time_us من -progress pipe:1 ونحسب النسبة من المدة الإجمالية
        const m = /out_time_us=(\d+)/g;
        let match;
        while ((match = m.exec(d.toString())) !== null) {
          const us = Number(match[1]);
          if (!Number.isFinite(us) || totalDuration <= 0) continue;
          const ratio = Math.min(1, us / 1_000_000 / totalDuration);
          const pct = 40 + Math.round(50 * ratio);
          const now = Date.now();
          if (pct > lastTick && now - lastTick > 0) {
            lastTick = pct;
            void onProgressTick(pct);
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(killTimer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-400)}`));
      });
    });

    /* 90-100%: فحص الحدود ثم تخزين الناتج في Turso */
    const outSize = fs.statSync(outPath).size;
    if (outSize > L.outputMaxBytes) {
      throw new Error(`حجم الناتج (${Math.round(outSize / 1024 / 1024)}MB) يتجاوز الحد المسموح`);
    }
    const outInfo = await probeFile(outPath);
    const buf = fs.readFileSync(outPath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    await onProgressTick(92);
    await db.storeBlob("output_chunks", jobId, 0, buf);
    await onProgressTick(100);

    await db.patchJob(jobId, {
      status: "done",
      progress: 100,
      outputSize: outSize,
      outputDuration: Number(outInfo.duration.toFixed(2)),
      outputResolution: `${outInfo.width}x${outInfo.height}`,
      outputSha256: sha256,
    });
    // بعد نجاح الدمج احذف source_chunks — الناتج فقط هو المطلوب
    await db.getDb().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });

    return {
      done: true,
      size: outSize,
      duration: Number(outInfo.duration.toFixed(2)),
      resolution: `${outInfo.width}x${outInfo.height}`,
      sha256,
    };
  } finally {
    // تنظيف /tmp دائمًا
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* تجاهل */ }
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* تجاهل */ }
  }
}

module.exports = {
  runMergeJob,
  probeFile,
  downloadUrl,
  ffmpegBin,
  ffprobeBin,
  ensureExecutable,
};
