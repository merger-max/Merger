/**
 * مزود Cloudflare Workers AI — الصور المجانية الدائمة (10,000 نيورون/يوم، تتجدد يوميًا).
 * الشكل المقاس من توثيق Cloudflare الرسمي:
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/black-forest-labs/flux-1-schnell
 *        Authorization: Bearer {API_TOKEN}
 *        body: { "prompt": "...", "steps": 4 }        ← flux-1-schnell: prompt + steps (≤8) فقط
 *        → { "result": { "image": "<base64>" }, "success": true, "errors": [], "messages": [] }
 * الصورة تعيد base64 تُستخدم مباشرة كـ data URI (وفق مثال التوثيق) — لا تنزيل وسائط على السيرفر.
 *
 * تنسيق المفتاح المقبول (حقل api_key):
 *   - "account_id:token"  ← الصيغة المضمونة دائمًا
 *   - token فقط           ← يُحلَّل account_id تلقائيًا من GET /accounts (يحتاج صلاحية قراءة الحسابات)
 * عند فشل تحليل الحساب نرمي رسالة تطابق PROVIDER_PATTERNS (فئة provider) ليجرَّب المفتاح التالي
 * بدل تعطيل المفتاح أو إيقاف المهمة — المفتاح يبقى نشطًا مع ملاحظة في آخر خطأ.
 */
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenerateTaskInput } from "./types";

const BASE = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 60_000;
const FLUX_STEPS = 4; // افتراضي توثيق flux-1-schnell — جودة جيدة بأقل نيورونات

const accountCache = new Map<string, string>(); // token → account_id

const ACCOUNT_RE = /^[0-9a-f]{32}$/i;

/** استخراج (account_id?, token) من نص المفتاح — "id:token" أو token فقط */
function splitKey(key: string): { accountId?: string; token: string } {
  const idx = key.indexOf(":");
  if (idx > 0) {
    const maybeId = key.slice(0, idx).trim();
    const rest = key.slice(idx + 1).trim();
    if (ACCOUNT_RE.test(maybeId) && rest) return { accountId: maybeId, token: rest };
  }
  return { token: key.trim() };
}

async function cfFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err: any) {
    throw new ProviderError(null, `network error: ${err?.message ?? String(err)}`);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(res.status, `invalid JSON response (HTTP ${res.status})`);
  }
  const ok = res.ok && body?.success !== false;
  if (!ok) {
    const first = Array.isArray(body?.errors) ? body.errors[0] : undefined;
    const msg =
      first?.message ||
      body?.error?.message ||
      body?.message ||
      body?.msg ||
      JSON.stringify(body).slice(0, 300);
    throw new ProviderError(res.status, String(msg));
  }
  return body;
}

/** حلّل معرف الحساب — من المفتاح مباشرة أو عبر GET /accounts (مخزَّن في الذاكرة) */
async function resolveAccountId(key: string): Promise<{ accountId: string; token: string }> {
  const { accountId, token } = splitKey(key);
  if (accountId) return { accountId, token };

  const cached = accountCache.get(token);
  if (cached) return { accountId: cached, token };

  try {
    const body = await cfFetch("/accounts", token);
    const first = Array.isArray(body?.result) ? body.result[0]?.id : undefined;
    if (first) {
      accountCache.set(token, String(first));
      return { accountId: String(first), token };
    }
  } catch {
    // توكن بلا صلاحية قائمة الحسابات — نرمي أدناه رسالة فئة provider
  }
  throw new ProviderError(
    404,
    "model not found: cloudflare account id unresolved — أضف المفتاح بصيغة account_id:token",
  );
}

export const cloudflareAdapter: ProviderAdapter = {
  /** صور متزامنة — النتيجة فورًا كـ data URI (لا مهمة غير متزامنة هنا) */
  async createImageSync(_key, input) {
    const { accountId, token } = await resolveAccountId(_key);
    const p = input.params ?? {};
    const body: Record<string, unknown> = { prompt: input.prompt, steps: FLUX_STEPS };
    // flux-1-schnell لا يدعم aspect_ratio/resolution — تُتجاهل بأمان ولا تُرسَل أصلًا
    void p;
    const data = await cfFetch(`/accounts/${accountId}/ai/run/${input.providerModel}`, token, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const image = data?.result?.image;
    if (typeof image !== "string" || !image.length) {
      throw new ProviderError(200, "missing base64 image in flux response");
    }
    return { urls: [`data:image/jpeg;base64,${image}`] };
  },

  async createTask() {
    // غير مستخدم — موديلات الصور هنا متزامنة عبر createImageSync
    throw new ProviderError(404, "model not found: cloudflare serves sync image generation only");
  },

  async checkTask() {
    throw new ProviderError(404, "model not found: cloudflare serves sync image generation only");
  },
};
