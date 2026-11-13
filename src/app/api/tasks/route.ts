/**
 * GET /api/tasks — أحدث المهام للوحة التحكم (تُستطلع من الواجهة كل ~5 ثوانٍ) + الإحصائيات.
 * DELETE /api/tasks?id=... — حذف مهمة (تنظيف).
 */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats, deleteTask } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT_MAX = 50;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "20");
  const limit = Math.max(1, Math.min(LIMIT_MAX, Number.isFinite(limitRaw) ? limitRaw : 20));
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  const [tasks, stats] = await Promise.all([
    listRecentTasks(limit, { type, status }),
    taskStats(),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => {
      let urls: string[] = [];
      let attempts: unknown[] = [];
      try {
        urls = (JSON.parse(t.result_urls_json || "[]") as string[]) ?? [];
      } catch { /* تجاهل */ }
      try {
        attempts = (JSON.parse(t.attempts_json || "[]") as unknown[]) ?? [];
      } catch { /* تجاهل */ }
      return {
        id: t.id,
        type: t.type,
        model: t.model,
        status: t.status,
        progress: t.progress,
        prompt: t.prompt.slice(0, 140),
        provider: t.provider,
        // نبذة عن المفتاح المستخدم دون كشف أي شيء حساس
        keyRef: t.key_id ? maskKey(t.key_id) : null,
        urls,
        errorMessage: t.status === "failed" ? t.error_message : null,
        attemptsCount: attempts.length,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        completedAt: t.completed_at,
      };
    }),
  });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "المعامل id مطلوب" }, { status: 400 });
  }
  await deleteTask(id);
  return NextResponse.json({ ok: true });
}
