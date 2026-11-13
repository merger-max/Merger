/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 *  - يحلل المسارات الديناميكية ويضعها في req.query
 *  - يحمّل .env يدويًا
 *  - يخدم public/ للواجهة و api/ كدوال serverless بنفس توقيع (req, res)
 * الاستخدام: node scripts/dev-server.js [port]
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

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

/* خريطة المسارات → ملفات الدوال */
const ROUTES = [
  { re: /^\/api\/jobs\/([A-Za-z0-9_-]+)\/video$/, file: "api/jobs/[id]/video.js", param: "id" },
  { re: /^\/api\/jobs\/([A-Za-z0-9_-]+)\/process$/, file: "api/jobs/[id]/process.js", param: "id" },
  { re: /^\/api\/jobs\/([A-Za-z0-9_-]+)$/, file: "api/jobs/[id].js", param: "id" },
  { re: /^\/api\/jobs$/, file: "api/jobs.js" },
  { re: /^\/api\/upload$/, file: "api/upload.js" },
  { re: /^\/api\/config$/, file: "api/config.js" },
  { re: /^\/api\/cron$/, file: "api/cron.js" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const port = Number(process.argv[2] || process.env.PORT || 3001);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // 1) مسارات API
  for (const route of ROUTES) {
    const m = route.re.exec(pathname);
    if (m) {
      if (route.param) req.query = { ...Object.fromEntries(url.searchParams), [route.param]: decodeURIComponent(m[1]) };
      else req.query = Object.fromEntries(url.searchParams);
      try {
        const handler = require(path.join(ROOT, route.file));
        await handler(req, res);
      } catch (err) {
        console.error(`[dev-server] ${pathname} failed:`, err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: String(err?.message ?? err) }));
        } else {
          res.end();
        }
      }
      return;
    }
  }

  // 2) الواجهة الثابتة
  let file = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(ROOT, "public", path.normalize(file).replace(/^([.]{2}[/\\])+/, ""));
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[path.extname(filePath)] ?? "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "غير موجود" }));
});

server.listen(port, () => {
  console.log(`[dev-server] Video Merger API v2 — http://localhost:${port}`);
  console.log(`[dev-server] TURSO: ${process.env.TURSO_DATABASE_URL ? "مضبوط" : "غير مضبوط!"}`);
});
