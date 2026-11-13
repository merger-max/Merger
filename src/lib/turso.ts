/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP فقط (متوافقة مع Vercel serverless).
 * لا ملفات SQLite محلية في الإنتاج إطلاقًا.
 */
import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

/** عميل واحد مشترك — يُنشأ عند أول استدعاء */
export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان في متغيرات البيئة");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

/** إنشاء الجداول عند أول وصول (بدون أداة migrations) — memoized مع إعادة محاولة عند فشل عابر */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)`,
      );
      await db.execute(
        `CREATE INDEX IF NOT EXISTS idx_keys_created ON api_keys (created_at ASC)`,
      );
    })().catch((err) => {
      // فشل عابر (شبكة) — أعد المحاولة في النداء القادم بدل حفظ الرفض للأبد
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

/** فحص صحة قاعدة البيانات: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getDb().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

/* ============================ أنواع الصفوف ============================ */

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: string;
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

/* ============================ عمليات المهام ============================ */

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt?: string;
  params_json?: string;
  status?: "pending" | "processing" | "completed" | "failed";
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt ?? "",
      t.params_json ?? "{}",
      t.status ?? "pending",
      t.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT * FROM tasks WHERE id = ? LIMIT 1`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  return mapTaskRow(r.rows[0]);
}

function mapTaskRow(row: any): TaskRow {
  return {
    id: String(row.id),
    provider: row.provider ?? null,
    provider_task_id: row.provider_task_id ?? null,
    key_id: row.key_id ?? null,
    model: String(row.model),
    type: row.type as TaskRow["type"],
    prompt: String(row.prompt ?? ""),
    params_json: String(row.params_json ?? "{}"),
    status: row.status as TaskRow["status"],
    progress: Number(row.progress ?? 0),
    result_urls_json: row.result_urls_json ?? null,
    error_message: row.error_message ?? null,
    attempts_json: String(row.attempts_json ?? "[]"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    completed_at: row.completed_at ?? null,
  };
}

/** تحديث جزئي — يضيف المحاولات إلى attempts_json ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(
  id: string,
  patch: Partial<{
    provider: string | null;
    provider_task_id: string | null;
    key_id: string | null;
    status: "pending" | "processing" | "completed" | "failed";
    progress: number;
    result_urls: string[] | null;
    error_message: string | null;
    new_attempt: AttemptEntry | null;
    reset_error: boolean;
  }>,
): Promise<void> {
  await ensureSchema();
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];

  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    // ضبط completed_at تلقائيًا عند الاكتمال أو الفشل النهائي
    if (patch.status === "completed" || patch.status === "failed") {
      sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
    }
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.max(0, Math.min(100, Math.round(patch.progress))));
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(patch.result_urls ? JSON.stringify(patch.result_urls) : null);
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (patch.reset_error) {
    sets.push("error_message = NULL");
  }
  if (patch.new_attempt) {
    // نقرأ المحاولات الحالية ونضيف إليها (قراءة ثم كتابة — التزامن هنا محدود التأثير)
    const current = await getTask(id);
    const attempts: AttemptEntry[] = current
      ? safeParseArray(current.attempts_json)
      : [];
    attempts.push(patch.new_attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts.slice(-50))); // حد أقصى 50 محاولة لتفادي نمو غير محدود
  }

  args.push(id);
  await getDb().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string },
): Promise<TaskRow[]> {
  await ensureSchema();
  const args: InValue[] = [];
  const conds: string[] = [];
  if (filters?.type) {
    conds.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    conds.push("status = ?");
    args.push(filters.status);
  }
  args.push(limit);
  const r = await getDb().execute({
    sql: `SELECT * FROM tasks ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args,
  });
  return r.rows.map(mapTaskRow);
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getDb().execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [id] });
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const r = await getDb().execute(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
      COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END), 0) AS processing
    FROM tasks
  `);
  const row = r.rows[0];
  return {
    total: Number(row?.total ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
    processing: Number(row?.processing ?? 0),
  };
}

/* ============================ عمليات المفاتيح ============================ */

export async function insertApiKey(k: {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
}): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label ?? "", k.api_key],
  });
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await getDb().execute(
    `SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`,
  );
  return r.rows.map(mapKeyRow);
}

function mapKeyRow(row: any): ApiKeyRow {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: String(row.label ?? ""),
    api_key: String(row.api_key),
    status: row.status as ApiKeyRow["status"],
    usage_count: Number(row.usage_count ?? 0),
    success_count: Number(row.success_count ?? 0),
    fail_count: Number(row.fail_count ?? 0),
    last_used_at: row.last_used_at ?? null,
    last_checked_at: row.last_checked_at ?? null,
    last_error: row.last_error ?? null,
    created_at: String(row.created_at ?? ""),
  };
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys WHERE id = ? LIMIT 1`,
    args: [id],
  });
  return r.rows.length ? mapKeyRow(r.rows[0]) : null;
}

export async function updateApiKey(
  id: string,
  patch: Partial<{
    status: "active" | "exhausted" | "disabled";
    usage_count_delta: number;
    success_delta: number;
    fail_delta: number;
    last_error: string | null;
    last_used_at: string | null;
    last_checked_at: string | null;
  }>,
): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (patch.usage_count_delta) {
    sets.push("usage_count = usage_count + ?");
    args.push(patch.usage_count_delta);
  }
  if (patch.success_delta) {
    sets.push("success_count = success_count + ?");
    args.push(patch.success_delta);
  }
  if (patch.fail_delta) {
    sets.push("fail_count = fail_count + ?");
    args.push(patch.fail_delta);
  }
  if (patch.last_error !== undefined) {
    sets.push("last_error = ?");
    args.push(patch.last_error);
  }
  if (patch.last_used_at !== undefined) {
    sets.push("last_used_at = ?");
    args.push(patch.last_used_at);
  }
  if (patch.last_checked_at !== undefined) {
    sets.push("last_checked_at = ?");
    args.push(patch.last_checked_at);
  }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({
    sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function deleteApiKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `DELETE FROM api_keys WHERE id = ?`,
    args: [id],
  });
  return r.rowsAffected > 0;
}

/** تجلب المفاتيح غير المعطّلة لهذه المزودات بالترتيب الصارم (أول مفتاح أُضيف يُجرَّب أولًا) */
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map(mapKeyRow);
}

/* ============================ أدوات مساعدة ============================ */

export function safeParseArray<T>(json: string | null | undefined): T[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function safeParseObject<T>(json: string | null | undefined, fallback: T): T {
  try {
    const v = json ? JSON.parse(json) : fallback;
    return (v && typeof v === "object" ? v : fallback) as T;
  } catch {
    return fallback;
  }
}

export function taskResultUrls(t: TaskRow): string[] {
  return safeParseArray<string>(t.result_urls_json);
}
