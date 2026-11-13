/**
 * أدوات HTTP مشتركة لكل الدوال — CORS مفتوح، أخطاء {"error":"..."}، قراءة الأجسام، Range.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, code, obj) {
  setCors(res);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

/** قراءة جسم الطلب كـ Buffer مع حد أقصى */
function readBodyBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("حجم الطلب يتجاوز الحد المسموح"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await readBodyBuffer(req, maxBytes);
  const text = buf.toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text); // قد يرمي SyntaxError — المتصل يلتقطها كـ 400
}

/** العنوان المطلق للخدمة من رؤوس الطلب */
function absoluteBase(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
  return `${proto}://${host}`;
}

/** تحليل ترويسة Range: bytes=start-end — يعيد {start, end} داخل الحدود */
function parseRange(rangeHeader, total) {
  if (!rangeHeader || !/^bytes=/i.test(rangeHeader)) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const [, a, b] = m;
  let start;
  let end;
  if (a === "" && b === "") return null;
  if (a === "") {
    // لاحقة: آخر N بايت
    const n = parseInt(b, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(a, 10);
    end = b === "" ? total - 1 : Math.min(parseInt(b, 10), total - 1);
    if (!Number.isFinite(start) || start >= total) return null;
    if (!Number.isFinite(end) || end < start) return null;
  }
  return { start, end };
}

function jsonErrorFromException(res, err, fallbackCode = 500) {
  const code = err && err.statusCode ? err.statusCode : fallbackCode;
  sendError(res, code, err && err.message ? String(err.message) : "خطأ غير متوقع");
}

module.exports = {
  setCors,
  handlePreflight,
  sendJson,
  sendError,
  readBodyBuffer,
  readJsonBody,
  absoluteBase,
  parseRange,
  jsonErrorFromException,
};
