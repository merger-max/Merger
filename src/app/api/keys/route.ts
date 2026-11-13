/**
 * مدير المفاتيح — GET القائمة (المفاتيح مقنَّعة دائمًا، لا يُعاد المفتاح الكامل أبدًا)
 * و POST إضافة مفتاح مع رفض التكرار لنفس المزود.
 */
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { insertApiKey, listApiKeys, getDb, ensureSchema, type ApiKeyRow } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_PROVIDERS = new Set(["kie", "cometapi"]);

function serializeKey(k: ApiKeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastCheckedAt: k.last_checked_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

export async function GET() {
  const keys = await listApiKeys();
  return NextResponse.json({ keys: keys.map(serializeKey) });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب" }, { status: 400 });
  }
  const provider = (body.provider ?? "").trim().toLowerCase();
  const apiKey = (body.api_key ?? "").trim();
  const label = (body.label ?? "").trim().slice(0, 80);

  if (!VALID_PROVIDERS.has(provider)) {
    return NextResponse.json(
      { error: "المزود يجب أن يكون kie أو cometapi" },
      { status: 400 },
    );
  }
  if (!apiKey) {
    return NextResponse.json({ error: "المفتاح مطلوب" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود (نقارن النص الكامل)
  await ensureSchema();
  const existing = await getDb().execute({
    sql: `SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1`,
    args: [provider, apiKey],
  });
  if (existing.rows.length) {
    return NextResponse.json(
      { error: "هذا المفتاح مضاف بالفعل لنفس المزود — الرفض لمنع التكرار" },
      { status: 409 },
    );
  }

  const id = randomUUID();
  await insertApiKey({ id, provider, label, api_key: apiKey });
  const rows = await listApiKeys();
  const created = rows.find((k) => k.id === id)!;
  return NextResponse.json({ key: serializeKey(created) }, { status: 201 });
}
