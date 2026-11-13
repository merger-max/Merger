/**
 * POST /api/jobs  — إنشاء مهمة دمج (روابط مباشرة أو مصادر ملفات)
 * GET  /api/jobs  — قائمة أحدث المهام (تدقيق)
 * يقبل: {"videos":["رابط1","رابط2"]} أو
 *       {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {jobId, status, statusUrl, processUrl, expiresAt, uploads?, uploadChunkBytes}
 */
const { randomUUID } = require("crypto");
const db = require("../lib/db");
const { sendJson, sendError, readJsonBody, absoluteBase, handlePreflight, jsonErrorFromException } = require("../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    if (req.method === "GET") {
      // تنظيف كسول ثم قائمة أحدث المهام
      await db.cleanupExpired().catch(() => 0);
      const r = db.getDb();
      const rows = await r.execute(
        `SELECT id, status, progress, created_at, expires_at, output_size, output_resolution FROM jobs ORDER BY created_at DESC LIMIT 50`,
      );
      return sendJson(res, 200, {
        jobs: rows.rows.map((j) => ({
          jobId: j.id,
          status: j.status,
          progress: Number(j.progress ?? 0),
          createdAt: j.created_at,
          expiresAt: j.expires_at,
          size: j.output_size ?? null,
          resolution: j.output_resolution ?? null,
        })),
      });
    }

    if (req.method !== "POST") {
      return sendError(res, 405, "الطريقة غير مسموحة — استخدم POST لإنشاء المهمة أو GET للقائمة");
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err.statusCode === 413) return sendError(res, 413, err.message);
      return sendError(res, 400, "JSON تالف — تعذر تحليل جسم الطلب");
    }

    // تنظيف كسول للمهام المنتهية (24 ساعة) عند كل طلب إنشاء
    await db.cleanupExpired().catch(() => 0);

    const L = db.limits();
    const base = absoluteBase(req);
    const sources = [];
    const uploads = [];

    if (Array.isArray(body.videos)) {
      for (const v of body.videos) {
        sources.push({ kind: "url", url: String(v ?? "").trim() });
      }
    } else if (Array.isArray(body.sources)) {
      for (const s of body.sources) {
        const kind = s && s.kind === "file" ? "file" : "url";
        if (kind === "url") {
          sources.push({ kind: "url", url: String(s.url ?? "").trim() });
        } else {
          sources.push({
            kind: "file",
            name: String(s.name ?? "file.mp4").slice(0, 200),
            size: Number.isFinite(Number(s.size)) ? Number(s.size) : null,
            mime: String(s.mime ?? "video/mp4").slice(0, 100),
          });
        }
      }
    } else {
      return sendError(res, 400, "جسم الطلب يجب أن يحتوي videos أو sources");
    }

    if (sources.length < 2) {
      return sendError(res, 400, `الدمج يحتاج مقطعين على الأقل (استلمت ${sources.length})`);
    }
    if (sources.length > L.maxSources) {
      return sendError(res, 400, `أقصى عدد مقاطع للدمج هو ${L.maxSources}`);
    }
    const badUrl = sources.find((s) => s.kind === "url" && !/^https?:\/\/.+/i.test(s.url));
    if (badUrl) {
      return sendError(res, 400, "كل الروابط يجب أن تكون http/https مباشرة وعامة");
    }

    const hasFiles = sources.some((s) => s.kind === "file");
    if (hasFiles) {
      // التحقق من أحجام الملفات المعلنة
      for (const s of sources) {
        if (s.kind === "file" && s.size && s.size > L.sourceMaxBytes) {
          return sendError(res, 413, `حجم ملف ${s.name} يتجاوز الحد المسموح (${Math.round(L.sourceMaxBytes / 1024 / 1024)}MB)`);
        }
      }
    }

    const jobId = randomUUID().replace(/-/g, "").slice(0, 12);
    const { expiresAt } = await db.createJob({ jobId, sources });

    const out = {
      jobId,
      status: hasFiles ? "uploading" : "queued",
      statusUrl: `${base}/api/jobs/${jobId}`,
      processUrl: `${base}/api/jobs/${jobId}/process`,
      expiresAt: `${expiresAt}Z`,
    };
    if (hasFiles) {
      out.uploadChunkBytes = L.uploadChunkBytes;
      out.uploads = sources
        .map((s, seq) => ({ seq, kind: s.kind }))
        .filter((s) => s.kind === "file")
        .map((s) => ({
          seq: s.seq,
          uploadUrl: `${base}/api/upload?job=${jobId}&seq=${s.seq}`,
        }));
    }
    return sendJson(res, 201, out);
  } catch (err) {
    return jsonErrorFromException(res, err);
  }
};
