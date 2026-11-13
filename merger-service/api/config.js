/**
 * GET /api/config — الحدود العامة + version (تُستخدم لفحص الجهوزية في /api/health).
 */
const db = require("../lib/db");
const { sendJson, handlePreflight } = require("../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    await db.ensureSchema();
    const L = db.limits();
    return sendJson(res, 200, {
      version: "2.0.0",
      maxSources: L.maxSources,
      sourceMaxMB: Math.round(L.sourceMaxBytes / 1024 / 1024),
      outputMaxMB: Math.round(L.outputMaxBytes / 1024 / 1024),
      maxTotalDurationSec: L.maxTotalDurationSec,
      uploadChunkBytes: L.uploadChunkBytes,
      storageChunkBytes: L.storageChunkBytes,
      expireHours: L.expireHours,
      output: { container: "mp4", video: "h264 (libx264, CRF 18)", audio: "aac 192k/44100Hz", faststart: true },
      // لا resolution/fps — الناتج ثابت (30fps بأكبر دقة بين المدخلات بحد 1920x1080)
      fixedFps: 30,
      maxResolution: "1920x1080",
    });
  } catch (err) {
    return sendJson(res, 200, {
      version: "2.0.0",
      healthy: false,
      error: String(err?.message ?? err).slice(0, 200),
    });
  }
};
