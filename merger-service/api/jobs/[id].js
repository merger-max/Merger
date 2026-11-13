/**
 * GET    /api/jobs/{id} — الحالة + التقدم (0-100) + الرابط عند الاكتمال
 * DELETE /api/jobs/{id} — حذف فوري شامل (jobs + sources + source_chunks + output_chunks)
 */
const db = require("../../lib/db");
const { sendJson, sendError, absoluteBase, handlePreflight, jsonErrorFromException } = require("../../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");

    if (req.method === "DELETE") {
      const job = await db.getJob(jobId);
      if (!job) return sendError(res, 404, "المهمة غير موجودة");
      await db.deleteJobCompletely(jobId);
      return sendJson(res, 200, { ok: true, jobId });
    }

    if (req.method !== "GET") {
      return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
    }

    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");

    const base = absoluteBase(req);
    const out = {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      expiresAt: `${job.expiresAt}Z`,
    };
    if (job.status === "done") {
      out.videoUrl = `${base}/api/jobs/${jobId}/video`;
      out.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      out.size = job.outputSize;
      out.duration = job.outputDuration;
      out.resolution = job.outputResolution;
    }
    if (job.status === "failed") {
      out.error = job.error || "فشل الدمج";
    }
    return sendJson(res, 200, out);
  } catch (err) {
    return jsonErrorFromException(res, err);
  }
};
