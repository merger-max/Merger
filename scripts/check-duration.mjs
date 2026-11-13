// فحص سريع لمدة المهام المعلقة — يقرأ القيم من .env.local ولا يطبع أي أسرار
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';

const env = readFileSync('/home/z/my-project/.env.local', 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const url = get('TURSO_DATABASE_URL');
const token = get('TURSO_AUTH_TOKEN');

const db = createClient({ url, authToken: token });

const rows = await db.execute(`
  SELECT id, kind, model, params, status, created_at
  FROM tasks
  ORDER BY created_at DESC
  LIMIT 20
`);

const seen = [];
for (const r of rows.rows) {
  let params = {};
  try { params = JSON.parse(r.params || '{}'); } catch {}
  const kind = r.kind || (params?.type ?? '?');
  const model = r.model || params?.model || '?';
  const dur = params?.duration ?? params?.video_duration ?? null;
  seen.push({
    id: String(r.id),
    kind: String(kind),
    model: String(model).slice(0, 40),
    duration: dur === null ? '(غير محدد في السجل)' : `${dur} ثانية`,
    status: String(r.status || '?'),
  });
}

console.log(JSON.stringify(seen, null, 2));

const durations = seen.map(s => s.duration).filter(d => d.includes('ثانية'));
const counts = {};
for (const d of durations) counts[d] = (counts[d] || 0) + 1;
console.log('الخلاصة:', counts);
