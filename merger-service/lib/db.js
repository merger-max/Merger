/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP، تخزين كل شيء هنا بلا S3 ولا خدمات خارجية.
 * جداول: jobs, sources, source_chunks, output_chunks (كل Blob مقسّم صفوف 2MB لحد HTTP في Turso).
 */
const { createClient } = require("@libsql/client");

let client = null;

function getDb() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    output_size INTEGER,
    output_duration REAL,
    output_resolution TEXT,
    output_sha256 TEXT,
    process_started_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    name TEXT,
    size INTEGER,
    mime TEXT,
    received_bytes INTEGER DEFAULT 0,
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, seq, chunk)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    chunk INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, chunk)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at)`,
];

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getDb();
      for (const sql of SCHEMA_SQL) {
        await db.execute(sql);
      }
      // ترحيل آمن: عمود process_started_at للجداول القديمة
      try {
        await db.execute(`ALTER TABLE jobs ADD COLUMN process_started_at TEXT`);
      } catch (e) {
        // العمود موجود بالفعل — تجاهل
      }
    })().catch((err) => {
      // فشل عابر (شبكة) — أعد المحاولة في النداء القادم بدل حفظ الرفض للأبد
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/* --------------------------- حدود قابلة للضبط --------------------------- */

function limits() {
  const n = (v, d) => {
    const x = parseInt(v, 10);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    maxSources: n(process.env.MAX_SOURCES, 10),
    sourceMaxBytes: n(process.env.SOURCE_MAX_MB, 200) * 1024 * 1024,
    outputMaxBytes: n(process.env.OUTPUT_MAX_MB, 150) * 1024 * 1024,
    maxTotalDurationSec: n(process.env.MAX_TOTAL_DURATION_SEC, 600),
    ffmpegPreset: process.env.FFMPEG_PRESET || "medium",
    // حجم جزء الرفع الواحد — أقل من حد Vercel للطلب (4.5MB)
    uploadChunkBytes: n(process.env.UPLOAD_CHUNK_BYTES, 4 * 1024 * 1024),
    // حجم صف التخزين في Turso (حد HTTP الآمن)
    storageChunkBytes: n(process.env.STORAGE_CHUNK_BYTES, 2 * 1024 * 1024),
    // عمق صفحة القراءة التدفقي
    readPageSize: n(process.env.READ_PAGE_SIZE, 8),
    expireHours: n(process.env.EXPIRE_HOURS, 24),
  };
}

function newExpiry() {
  const ms = limits().expireHours * 3600 * 1000;
  return new Date(Date.now() + ms).toISOString().replace("T", " ").slice(0, 19);
}

function isExpired(expiresAt) {
  return Date.parse(expiresAt.replace(" ", "T") + "Z") < Date.now();
}

/* ------------------------------- المهام ------------------------------- */

async function createJob({ sources, jobId }) {
  await ensureSchema();
  const expiresAt = newExpiry();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, 'queued', 0, ?)`,
    args: [jobId, expiresAt],
  });
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    await getDb().execute({
      sql: `INSERT INTO sources (job_id, seq, kind, url, name, size, mime, received_bytes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        jobId,
        i,
        s.kind,
        s.url ?? null,
        s.name ?? null,
        s.size ?? null,
        s.mime ?? null,
        s.kind === "url" ? s.size ?? 0 : 0,
      ],
    });
  }
  return { jobId, expiresAt };
}

async function getJob(jobId) {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT * FROM jobs WHERE id = ? LIMIT 1`,
    args: [jobId],
  });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const sources = await getDb().execute({
    sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`,
    args: [jobId],
  });
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress ?? 0),
    error: row.error ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    outputSize: row.output_size,
    outputDuration: row.output_duration,
    outputResolution: row.output_resolution,
    outputSha256: row.output_sha256,
    sources: sources.rows.map((s) => ({
      seq: Number(s.seq),
      kind: s.kind,
      url: s.url,
      name: s.name,
      size: s.size,
      mime: s.mime,
      receivedBytes: Number(s.received_bytes ?? 0),
    })),
  };
}

async function patchJob(jobId, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    args.push(patch.error);
  }
  if (patch.outputSize !== undefined) {
    sets.push("output_size = ?");
    args.push(patch.outputSize);
  }
  if (patch.outputDuration !== undefined) {
    sets.push("output_duration = ?");
    args.push(patch.outputDuration);
  }
  if (patch.outputResolution !== undefined) {
    sets.push("output_resolution = ?");
    args.push(patch.outputResolution);
  }
  if (patch.outputSha256 !== undefined) {
    sets.push("output_sha256 = ?");
    args.push(patch.outputSha256);
  }
  if (!sets.length) return;
  args.push(jobId);
  await getDb().execute({
    sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

/** حذف شامل — كل صفوف المهمة في batch واحد */
async function deleteJobCompletely(jobId) {
  await ensureSchema();
  const db = getDb();
  await db.batch(
    [
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [jobId] },
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [jobId] },
    ],
    "write",
  );
}

/** تنظيف كسول + نقطة cron — يحذف المهام المنتهية الصلاحية بكل أجزائها */
async function cleanupExpired() {
  await ensureSchema();
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT id FROM jobs WHERE expires_at < datetime('now') LIMIT 50`,
  });
  let deleted = 0;
  for (const row of r.rows) {
    await deleteJobCompletely(String(row.id));
    deleted++;
  }
  return deleted;
}

/* --------------------------- تخزين Blobs مجزّأ --------------------------- */

/** تخزين Buffer في source_chunks أو output_chunks على صفوف storageChunkBytes */
async function storeBlob(table, jobId, seqOrZero, data, onProgress) {
  const size = limits().storageChunkBytes;
  const total = Math.ceil(data.length / size);
  const db = getDb();
  const isSource = table === "source_chunks";
  // نمسح أجزاء سابقة لنفس المفتاح (إعادة رفع)
  await db.execute({
    sql: isSource
      ? `DELETE FROM source_chunks WHERE job_id = ? AND seq = ?`
      : `DELETE FROM output_chunks WHERE job_id = ?`,
    args: isSource ? [jobId, seqOrZero] : [jobId],
  });
  for (let i = 0; i < total; i++) {
    const buf = data.subarray(i * size, (i + 1) * size);
    await db.execute({
      sql: isSource
        ? `INSERT INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)`
        : `INSERT INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)`,
      args: isSource ? [jobId, seqOrZero, i, buf] : [jobId, i, buf],
    });
    if (onProgress && (i % 8 === 0 || i === total - 1)) {
      await onProgress(Math.round(((i + 1) / total) * 100));
    }
  }
  return total;
}

/** يولّد Buffers متتالية من صفوف التخزين بصفحات readPageSize (تدفق بلا تحميل كامل) */
async function* iterateBlob(table, jobId, seqOrZero) {
  const pageSize = limits().readPageSize;
  const isSource = table === "source_chunks";
  let cursor = 0;
  const db = getDb();
  for (;;) {
    const r = isSource
      ? await db.execute({
          sql: `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${pageSize}`,
          args: [jobId, seqOrZero, cursor],
        })
      : await db.execute({
          sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${pageSize}`,
          args: [jobId, cursor],
        });
    if (!r.rows.length) return;
    for (const row of r.rows) {
      // data يصل من Turso كـ Uint8Array/Buffer (JSON بيس أو كائن) — نوحّدها Buffer
      let buf;
      if (row.data instanceof Uint8Array) buf = Buffer.from(row.data);
      else if (Array.isArray(row.data)) buf = Buffer.from(row.data);
      else if (typeof row.data === "string") buf = Buffer.from(row.data, "base64");
      else if (row.data instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(row.data));
      else if (row.data && typeof row.data === "object" && row.data.data) buf = Buffer.from(row.data.data);
      else buf = Buffer.alloc(0);
      if (buf.length) yield { chunk: Number(row.chunk), buf };
      cursor = Number(row.chunk) + 1;
    }
    if (r.rows.length < pageSize) return;
  }
}

/** جمع ملف مصدر مرفوع كاملًا إلى Buffer (للتحقق والحذف بالاختبار) */
async function readSourceFully(jobId, seq) {
  const parts = [];
  for await (const { buf } of iterateBlob("source_chunks", jobId, seq)) {
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

async function readOutputFully(jobId) {
  const parts = [];
  for await (const { buf } of iterateBlob("output_chunks", jobId, 0)) {
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

async function updateSourceReceived(jobId, seq, receivedBytes) {
  await getDb().execute({
    sql: `UPDATE sources SET received_bytes = ? WHERE job_id = ? AND seq = ?`,
    args: [receivedBytes, jobId, seq],
  });
}

/**
 * استحواذ ذري على تنفيذ process — يسمح بإعادة التنفيذ عندما تُقطع عملية سابقة
 * (status=processing بلا بداية مسجلة أو بداية قديمة متجاوزة للحد) ويمنع التزامن الحقيقي.
 * يعيد true إذا نالت هذه النداء حق التنفيذ.
 */
async function claimProcess(jobId, staleSec = 150) {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `UPDATE jobs SET process_started_at = datetime('now')
          WHERE id = ?
            AND (process_started_at IS NULL
                 OR process_started_at < datetime('now', '-${parseInt(staleSec, 10) || 150} seconds'))`,
    args: [jobId],
  });
  return r.rowsAffected > 0;
}

/** تجديد الاستحواذ أثناء العمل (كل كتابة تقدم تجدد البداية) */
async function renewProcessClaim(jobId) {
  await getDb().execute({
    sql: `UPDATE jobs SET process_started_at = datetime('now') WHERE id = ?`,
    args: [jobId],
  });
}

module.exports = {
  getDb,
  ensureSchema,
  limits,
  newExpiry,
  isExpired,
  createJob,
  getJob,
  patchJob,
  deleteJobCompletely,
  cleanupExpired,
  storeBlob,
  iterateBlob,
  readSourceFully,
  readOutputFully,
  updateSourceReceived,
  claimProcess,
  renewProcessClaim,
};
