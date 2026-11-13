/**
 * POST /api/jobs/{id}/process — تنفيذ الدمج كاملًا (متزامن ~10-15 ثانية أو أكثر حسب الحجم).
 * نجاح 200 → {status:"done", videoUrl, downloadUrl, size, duration, resolution, expiresAt}
 * قيد المعالجة بالفعل → 202. فشل → HTTP 500 + {"error":"..."} (فشل حتمي نهائي).
 */
const db = require("../../../lib/db");
const { runMergeJob } = require("../../../lib/merge");
const { sendJson, sendError, absoluteBase, handlePreflight, jsonErrorFromException } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== "POST") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST");
  }
  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");

    const existing = await db.getJob(jobId);
    if (!existing) return sendError(res, 404, "المهمة غير موجودة");

    if (existing.status === "done") {
      // idempotent — أعيد نفس النتيجة
      const base = absoluteBase(req);
      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: existing.outputSize,
        duration: existing.outputDuration,
        resolution: existing.outputResolution,
        expiresAt: `${existing.expiresAt}Z`,
      });
    }
    if (existing.status === "failed") {
      return sendError(res, 500, existing.error || "فشل الدمج مسبقًا — المهمة حتمية ولا تُعاد");
    }

    // استحواذ ذري: queued/uploading تُنفَّذ فورًا؛ processing تُنفَّذ فقط إن كانت عملية سابقة
    // مقطوعة (بداية قديمة أو غائبة) — وإن كانت تعمل فعلًا → 202
    const claimed = await db.claimProcess(jobId);
    if (!claimed) {
      return sendJson(res, 202, { status: "processing", progress: existing.progress });
    }

    // المصادر المرفوعة يجب أن تكون مكتملة أولًا
    for (const s of existing.sources) {
      if (s.kind === "file") {
        const expected = s.size;
        if (expected && s.receivedBytes !== expected) {
          return sendError(res, 409, `المصدر ${s.seq + 1} غير مكتمل الرفع (${s.receivedBytes}/${expected} بايت)`);
        }
      }
    }

    // تنفيذ الدمج — التقدم يُكتب في القاعدة أثناء العمل (0-40 سحب، 40-90 ترميز، 100 اكتمال)
    // كل كتابة تقدم تُجدد الاستحواذ حتى لا يُعتبر التنفيذ مقطوعًا
    const result = await runMergeJob(jobId, (p) => {
      void (async () => {
        try {
          await db.patchJob(jobId, { progress: Math.max(2, Math.min(100, p)) });
          await db.renewProcessClaim(jobId);
        } catch { /* تجاهل */ }
      })();
    });

    const fresh = await db.getJob(jobId);
    const base = absoluteBase(req);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: `${base}/api/jobs/${jobId}/video`,
      downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: `${fresh.expiresAt}Z`,
    });
  } catch (err) {
    // فشل معلن = حتمي نهائي — نعلّم المهمة failed ولا تُعاد المحاولة
    const jobId = String(req.query.id ?? "");
    try {
      await db.patchJob(jobId, { status: "failed", error: String(err?.message ?? err).slice(0, 500) });
    } catch { /* تجاهل */ }
    return sendError(res, err.statusCode ?? 500, String(err?.message ?? "فشل الدمج"));
  }
};
