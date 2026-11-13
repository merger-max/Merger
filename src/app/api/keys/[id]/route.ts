/**
 * PATCH /api/keys/{id} — تعطيل/تنشيط يدوي (status: active | disabled)
 * DELETE /api/keys/{id} — حذف نهائي.
 */
import { NextResponse } from "next/server";
import { deleteApiKey, updateApiKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب غير صالح — JSON مطلوب" }, { status: 400 });
  }
  const status = (body.status ?? "").toLowerCase();
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json(
      { error: "status يجب أن يكون active أو disabled (تعطيل/تنشيط يدوي)" },
      { status: 400 },
    );
  }
  await updateApiKey(id, { status, last_error: null });
  return NextResponse.json({ ok: true, id, status });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = await deleteApiKey(id);
  if (!deleted) {
    return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, id });
}
