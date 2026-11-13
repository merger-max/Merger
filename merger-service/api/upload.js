/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB).
 * الجسم application/octet-stream خام. يقسم الجسم إلى صفوف تخزين 2MB (حد HTTP في Turso).
 */
const db = require("../lib/db");
const { sendJson, sendError, readBodyBuffer, handlePreflight, jsonErrorFromException } = require("../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  }
  try {
    const jobId = String(req.query.job ?? "");
    const seq = Number(req.query.seq);
    const chunk = Number(req.query.chunk);
    if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk) || seq < 0 || chunk < 0) {
      return sendError(res, 400, "المعاملات المطلوبة: job و seq و chunk");
    }

    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    if (["done", "failed", "processing"].includes(job.status)) {
      return sendError(res, 409, `لا يمكن الرفع في حالة ${job.status}`);
    }
    const src = job.sources.find((s) => s.seq === seq);
    if (!src) return sendError(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") {
      return sendError(res, 400, "المصدر رابط مباشر — لا يقبل الرفع");
    }

    const L = db.limits();
    const body = await readBodyBuffer(req, L.uploadChunkBytes + 64 * 1024);

    if (body.length === 0) {
      return sendError(res, 400, "الجسم فارغ");
    }
    if (src.size && src.receivedBytes + body.length > src.size) {
      return sendError(res, 413, `الرفع يتجاوز الحجم المعلن للملف (${src.size} بايت)`);
    }

    // تخزين: كل جزء رفع يُقسم إلى صفوف تخزين 2MB متسلسلة: chunk * SUB + j
    const SUB = Math.ceil(L.uploadChunkBytes / L.storageChunkBytes);
    const parts = Math.ceil(body.length / L.storageChunkBytes);
    for (let j = 0; j < parts; j++) {
      const slice = body.subarray(j * L.storageChunkBytes, (j + 1) * L.storageChunkBytes);
      await db.getDb().execute({
        sql: `INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`,
        args: [jobId, seq, chunk * SUB + j, slice],
      });
    }
    const received = (src.receivedBytes || 0) + body.length;
    await db.updateSourceReceived(jobId, seq, received);

    // إن اكتمل كل الملفات المعلنة → uploading انتهت
    const allDone = job.sources.every((s) => {
      if (s.kind === "url") return true;
      const r = s.seq === seq ? received : s.receivedBytes || 0;
      return !s.size || r >= s.size;
    });
    if (allDone && job.status === "uploading") {
      await db.patchJob(jobId, { status: "queued", progress: 0 });
    }

    return sendJson(res, 200, { ok: true, seq, chunk, receivedBytes: received });
  } catch (err) {
    return jsonErrorFromException(res, err);
  }
};
