/**
 * GET /api/health — جهوزية النظام: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، والمصادقة.
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { listModelSummaries } from "@/lib/models";
import { mergerClient, mergerBase } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [ok, merger] = await Promise.all([
    dbHealthy().catch(() => false),
    mergerClient.getConfig(4000).catch(() => ({ healthy: false })),
  ]);

  return NextResponse.json({
    ok,
    database: ok ? "turso-connected" : "turso-disconnected",
    mcpEndpoint: "/mcp",
    models: listModelSummaries(),
    merger: { base: mergerBase() || null, healthy: merger.healthy },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
