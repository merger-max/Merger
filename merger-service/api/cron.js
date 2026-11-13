/**
 * GET /api/cron — حذف المهام المنتهية الصلاحية (Cron يومي في vercel.json).
 * كل الملفات تُحذف تلقائيًا بعد 24 ساعة (expires_at) — هنا التنظيف المضبوط.
 */
const db = require("../lib/db");
const { sendJson, handlePreflight } = require("../lib/http");

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const deleted = await db.cleanupExpired();
    return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: String(err?.message ?? err).slice(0, 300) });
  }
};
