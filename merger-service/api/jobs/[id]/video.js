/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range) و ?download=1 للتحميل.
 * يقرأ صفوف output_chunks من Turso تدفقيًا ويقليم أول/آخر جزء حسب المدى المطلوب.
 */
const db = require("../../../lib/db");
const { setCors, sendError, handlePreflight, parseRange } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendError(res, 405, "الطريقة غير مسموحة — استخدم GET");
  }
  try {
    const jobId = String(req.query.id ?? "");
    if (!jobId) return sendError(res, 400, "معرّف المهمة مطلوب");

    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, "المهمة غير موجودة");
    if (job.status !== "done") {
      return sendError(res, 404, "الناتج غير جاهز — المهمة ليست في حالة done");
    }

    // الحجم الكلي من مجموع الصفوف
    const r = db.getDb();
    const agg = await r.execute({
      sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total, COUNT(*) AS rows_count FROM output_chunks WHERE job_id = ?`,
      args: [jobId],
    });
    const total = Number(agg.rows[0]?.total ?? 0);
    if (total <= 0) return sendError(res, 404, "لا يوجد ناتج مخزّن لهذه المهمة");

    const range = parseRange(req.headers.range, total);
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const length = end - start + 1;

    setCors(res);
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", String(length));
    res.setHeader("Cache-Control", "no-store");
    const fname = `merged-${jobId}.mp4`;
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="${fname}"`);
    }
    if (range) {
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    // بث الصفوف مع تقليم أول/آخر جزء حسب المدى
    let offset = 0; // موضع البايت الحالي داخل الملف الكلي
    let remaining = length;
    const storageChunk = db.limits().storageChunkBytes;
    // نبدأ من الصفحة التي تحوي start
    let cursor = Math.floor(start / storageChunk);
    for (;;) {
      if (remaining <= 0) break;
      const page = await r.execute({
        sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? ORDER BY chunk ASC LIMIT 8`,
        args: [jobId, cursor],
      });
      if (!page.rows.length) break;
      for (const row of page.rows) {
        let buf;
        if (row.data instanceof Uint8Array) buf = Buffer.from(row.data);
        else if (Array.isArray(row.data)) buf = Buffer.from(row.data);
        else if (typeof row.data === "string") buf = Buffer.from(row.data, "base64");
        else if (row.data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(row.data));
        else if (row.data && typeof row.data === "object" && row.data.data) buf = Buffer.from(row.data.data);
        else buf = Buffer.alloc(0);
        if (!buf.length) continue;

        const chunkStart = Number(row.chunk) * storageChunk;
        const chunkEnd = chunkStart + buf.length; // حصري
        // تقاطع [start,end] مع [chunkStart,chunkEnd)
        const s = Math.max(start, chunkStart);
        const e = Math.min(end + 1, chunkEnd);
        if (e > s) {
          const slice = buf.subarray(s - chunkStart, e - chunkStart);
          const out = remaining < slice.length ? slice.subarray(0, remaining) : slice;
          if (!res.write(out)) {
            await new Promise((resolve) => res.once("drain", resolve));
          }
          remaining -= out.length;
        }
        cursor = Number(row.chunk) + 1;
        offset = chunkEnd;
        if (remaining <= 0) break;
      }
      if (page.rows.length < 8) break;
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      sendError(res, 500, String(err?.message ?? "خطأ في البث"));
    } else {
      res.end();
    }
  }
};
