/**
 * مسار /mcp — خادم MCP عبر Streamable HTTP (مواصفات MCP الرسمية).
 * SDK 1.32+: WebStandardStreamableHTTPServerTransport يعمل بـ Request/Response القياسية
 * مباشرة داخل Next.js App Router — بلا أي جسر Node، ويدعم بث SSE لإشعارات التقدم.
 * وضع stateless (sessionIdGenerator: undefined): كل طلب مستقل — مناسب لبيئة serverless على Vercel.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcpServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار داخل الطلب قد تصل 240 ثانية — المسموح الأقصى الشائع على Vercel هو 300
export const maxDuration = 300;

/** إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token> على /mcp */
function checkAuth(req: Request): Response | null {
  const expected = process.env.MCP_ACCESS_TOKEN;
  if (!expected) return null;
  const header = req.headers.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: Bearer token required (MCP_ACCESS_TOKEN)" },
        id: null,
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return null;
}

/** خادم + نقل جديد لكل طلب (stateless) — لا يمكن إعادة استخدام النقل stateless عبر الطلبات */
async function handle(req: Request, parsedBody?: unknown): Promise<Response> {
  const auth = checkAuth(req);
  if (auth) return auth;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = createMcpServer();
  await server.connect(transport);

  try {
    return await transport.handleRequest(req, { parsedBody });
  } catch (err) {
    console.error("[mcp] handler error:", err);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export async function POST(req: Request) {
  // نقرأ الجسم ونحلله مرة واحدة لتمرير parsedBody للنقل (يشترطه SDK مع الأجسام المقروءة مسبقًا)
  let parsedBody: unknown;
  try {
    const text = await req.text();
    parsedBody = text ? JSON.parse(text) : undefined;
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
        id: null,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  return handle(req, parsedBody);
}

// GET يفتح مجرى SSE مستقلًا لإشعارات الخادم (اختياري وفق المواصفة) وDELETE ينهي الجلسة
export async function GET(req: Request) {
  return handle(req);
}

export async function DELETE(req: Request) {
  return handle(req);
}
