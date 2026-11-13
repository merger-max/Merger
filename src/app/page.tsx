"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";

/* ================================ الأنواع ================================ */

interface HealthState {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  provider: string | null;
  urls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

/* ============================ أدوات مساعدة ============================ */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ar-EG", { hour12: false, dateStyle: "short", timeStyle: "short" });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const TYPE_EMOJI: Record<string, string> = { image: "🖼️", video: "🎬", merge: "🎞️" };

/* ===================== رقائق الأدوات الخمس (ثابتة) ===================== */

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي بموديل gpt-image-2-6/flare-text-to-image مع تبديل تلقائي عبر كل المفاتيح." },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي بموديل grok-imagine-video-1-5-preview مع image-to-video اختياري." },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المعطى عبر urls أو task_ids — الناتج يُحذف بعد ~24 ساعة." },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — صور/فيديو/دمج — ويحدّث حالتها حية من المزود." },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها من قاعدة البيانات بدون إعادة توليد." },
];

/* ================================ الصفحة ================================ */

export default function Dashboard() {
  const { toast } = useToast();
  const [health, setHealth] = useState<HealthState | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [adding, setAdding] = useState(false);

  const originRef = useRef<string>("");
  useEffect(() => {
    originRef.current = window.location.origin;
  }, []);

  /* ------------------- الجلب الدوري كل ~5 ثوانٍ ------------------- */
  const refresh = useCallback(async () => {
    try {
      const [h, k, t] = await Promise.all([
        fetch("/api/health", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/keys", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/tasks?limit=20", { cache: "no-store" }).then((r) => r.json()),
      ]);
      setHealth(h);
      setKeys(k.keys ?? []);
      setTasks(t.tasks ?? []);
      setStats(t.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 });
    } catch {
      // الشبكة تقطعت — الدورة القادمة تعيد المحاولة
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  /* ------------------- عمليات المفاتيح ------------------- */
  const addKey = async () => {
    if (!apiKeyInput.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKeyInput.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: "تعذّر الإضافة", description: data.error ?? "خطأ غير معروف", variant: "destructive" });
        return;
      }
      setApiKeyInput("");
      setLabel("");
      toast({ title: "تمت إضافة المفتاح — سيُجرَّب أولًا وفق الترتيب التسلسلي" });
      void refresh();
    } finally {
      setAdding(false);
    }
  };

  const toggleKey = async (k: KeyItem) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    void refresh();
  };

  const deleteKey = async (k: KeyItem) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "تم حذف المفتاح" });
    void refresh();
  };

  /* ------------------- تكوينات الربط ------------------- */
  const configs = useMemo(() => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${base}/mcp`;
    const auth = health?.authRequired;
    const headers = auth ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
    return {
      chatgpt: JSON.stringify(
        { mcpServers: { "media-generator": headers ? { url, headers } : { url } } },
        null,
        2,
      ),
      claude: JSON.stringify(
        { mcpServers: { "media-generator": headers ? { type: "http", url, headers } : { type: "http", url } } },
        null,
        2,
      ),
      cursor: JSON.stringify(
        { mcpServers: { "media-generator": headers ? { url, headers } : { url } } },
        null,
        2,
      ),
    };
  }, [health, originRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const copyConfig = async (text: string) => {
    const okk = await copyText(text);
    toast(okk ? { title: "تم النسخ ✓" } : { title: "تعذر النسخ", variant: "destructive" });
  };

  /* ================================ الواجهة ================================ */
  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* ------------------------------- الهيدر ------------------------------- */}
      <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-xl">
              ⚡
            </div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight">MCP Media Generator</h1>
              <p className="text-xs text-zinc-400">
                خادم MCP لتوليد الصور والفيديو ودمج المقاطع — مفاتيح تسلسلية بتبديل تلقائي
              </p>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2 flex-wrap">
            {health ? (
              <>
                <Badge
                  className={health.ok ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-red-500/15 text-red-300 border-red-500/40"}
                  variant="outline"
                >
                  <span className={`inline-block h-2 w-2 rounded-full ms-0 me-1.5 ${health.ok ? "bg-emerald-400" : "bg-red-400"}`} />
                  {health.ok ? "Turso متصل" : "غير متصل"}
                </Badge>
                <Badge
                  className={health.merger?.healthy ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" : "bg-amber-500/15 text-amber-300 border-amber-500/40"}
                  variant="outline"
                >
                  خدمة الدمج: {health.merger?.healthy ? "جاهزة" : "غير مهيأة"}
                </Badge>
              </>
            ) : (
              <Badge variant="outline" className="bg-zinc-800 text-zinc-300 border-zinc-700">جارٍ الفحص…</Badge>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* ------------------------- أ) مدير المفاتيح ------------------------- */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-bold text-base">مدير المفاتيح</h2>
              <p className="text-xs text-zinc-400 mt-1">
                أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند
                أي خطأ أو نفاد رصيد دون توقف.
              </p>
            </div>
            <Badge variant="outline" className="bg-zinc-800 border-zinc-700 text-zinc-300">{keys.length} مفتاح</Badge>
          </div>

          <div className="p-5 grid gap-4">
            {/* نموذج الإضافة */}
            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_1fr_auto] gap-2 items-stretch">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100"
                aria-label="المزود"
              >
                <option value="kie">kie.ai</option>
                <option value="cometapi">CometAPI</option>
              </select>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="تسمية اختيارية (مثل: المفتاح الأساسي)"
                className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm placeholder:text-zinc-500"
              />
              <input
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="الصق مفتاح API هنا"
                type="text"
                dir="ltr"
                className="h-10 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm font-mono placeholder:text-zinc-500 text-left"
                onKeyDown={(e) => e.key === "Enter" && void addKey()}
              />
              <Button onClick={addKey} disabled={adding} className="bg-emerald-600 hover:bg-emerald-500 text-white">
                {adding ? "جارٍ…" : "إضافة"}
              </Button>
            </div>

            {/* قائمة المفاتيح */}
            <div className="max-h-96 overflow-y-auto rounded-xl border border-zinc-800 divide-y divide-zinc-800">
              {keys.length === 0 && (
                <div className="p-6 text-center text-sm text-zinc-500">
                  لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد.
                </div>
              )}
              {keys.map((k) => (
                <div key={k.id} className="p-4 flex flex-wrap items-center gap-3">
                  <Badge variant="outline" className="bg-zinc-800 border-zinc-700 text-zinc-300 font-mono">
                    {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                  </Badge>
                  <code dir="ltr" className="text-sm font-mono text-zinc-200 bg-zinc-800/70 px-2 py-1 rounded">
                    {k.maskedKey}
                  </code>
                  {k.label && <span className="text-xs text-zinc-400">{k.label}</span>}
                  <KeyStatusBadge status={k.status} />
                  <span className="text-xs text-zinc-400" title="استخدام / نجاح / فشل">
                    الاستخدام {k.usageCount} • نجاح {k.successCount} • فشل {k.failCount}
                  </span>
                  <span className="text-xs text-zinc-500">آخر استخدام: {fmtTime(k.lastUsedAt)}</span>
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => void toggleKey(k)} className="border-zinc-700 text-zinc-200">
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void deleteKey(k)} className="border-red-900 text-red-300 hover:bg-red-900/30">
                      حذف
                    </Button>
                  </div>
                  {k.lastError && (
                    <div className="w-full text-xs text-amber-300/90 bg-amber-500/5 border border-amber-500/20 rounded px-2 py-1 truncate" title={k.lastError ?? ""}>
                      آخر خطأ: {k.lastError}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------- ب) لوحة المهام ------------------------- */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-bold text-base">لوحة المهام</h2>
              <p className="text-xs text-zinc-400 mt-1">تتحدث تلقائيًا كل ~5 ثوانٍ — بلا أي تخزين وسائط محليًا (روابط فقط)</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <StatChip label="الإجمالي" value={stats.total} cls="bg-zinc-800 text-zinc-200 border-zinc-700" />
              <StatChip label="مكتملة" value={stats.completed} cls="bg-emerald-500/10 text-emerald-300 border-emerald-500/30" />
              <StatChip label="فاشلة" value={stats.failed} cls="bg-red-500/10 text-red-300 border-red-500/30" />
              <StatChip label="جارية" value={stats.processing} cls="bg-amber-500/10 text-amber-300 border-amber-500/30" />
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-zinc-800">
            {tasks.length === 0 && (
              <div className="p-6 text-center text-sm text-zinc-500">
                لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP.
              </div>
            )}
            {tasks.map((t) => (
              <div key={t.id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">{TYPE_EMOJI[t.type] ?? "•"} {TYPE_LABEL[t.type] ?? t.type}</span>
                  <TaskStatusBadge status={t.status} />
                  <code className="text-[11px] font-mono text-zinc-400 bg-zinc-800/60 px-1.5 py-0.5 rounded" dir="ltr">{t.id.slice(0, 8)}</code>
                  <span className="text-xs text-zinc-400 font-mono" dir="ltr">{t.model}</span>
                  {t.provider && <Badge variant="outline" className="bg-zinc-800 border-zinc-700 text-zinc-300 text-[10px]">{t.provider}</Badge>}
                  <span className="text-xs text-zinc-500">المحاولات: {t.attemptsCount}</span>
                  <span className="text-xs text-zinc-500">{fmtTime(t.createdAt)}</span>
                </div>
                {t.prompt && <p className="text-xs text-zinc-400 truncate" title={t.prompt}>{t.prompt}</p>}
                {t.status === "processing" && (
                  <div className="flex items-center gap-2">
                    <Progress value={t.progress} className="h-2 bg-zinc-800" />
                    <span className="text-xs text-amber-300 shrink-0">{t.progress}%</span>
                  </div>
                )}
                {t.status === "completed" && t.urls.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {t.urls.map((u) => (
                      <a
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1 hover:bg-emerald-500/20"
                      >
                        🔗 فتح النتيجة
                      </a>
                    ))}
                    <Button size="sm" variant="outline" className="h-6 text-[11px] border-zinc-700" onClick={() => void copyConfig(t.urls.join("\n"))}>
                      نسخ الروابط
                    </Button>
                  </div>
                )}
                {t.status === "failed" && t.errorMessage && (
                  <p className="text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded px-2 py-1">{t.errorMessage}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------- ج) ربط السيرفر ------------------------- */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800">
            <h2 className="font-bold text-base">ربط السيرفر</h2>
            <p className="text-xs text-zinc-400 mt-1">انسخ الرابط والصقه في أي عميل MCP — لا حاجة لأي ملف آخر</p>
          </div>
          <div className="p-5 space-y-4">
            {/* الرابط المطلق */}
            <div className="flex flex-wrap items-center gap-2">
              <code dir="ltr" className="flex-1 min-w-56 text-sm font-mono bg-zinc-800/70 border border-zinc-700 rounded px-3 py-2 text-left text-emerald-300">
                {(typeof window !== "undefined" ? window.location.origin : "https://<your-app>.vercel.app") + "/mcp"}
              </code>
              <Button
                variant="outline"
                className="border-zinc-700"
                onClick={() => void copyConfig((typeof window !== "undefined" ? window.location.origin : "") + "/mcp")}
              >
                نسخ الرابط
              </Button>
            </div>

            {/* تبويبات JSON */}
            <TabsDemo configs={configs} onCopy={copyConfig} />

            {/* رقائق الأدوات */}
            <div className="grid gap-2 sm:grid-cols-2">
              {TOOL_CHIPS.map((tool) => (
                <div key={tool.name} className="rounded-lg border border-zinc-800 bg-zinc-800/40 px-3 py-2">
                  <code dir="ltr" className="text-xs font-mono text-emerald-300">{tool.name}</code>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{tool.desc}</p>
                </div>
              ))}
            </div>

            {/* ملاحظة كهرمانية */}
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-200/90 leading-relaxed">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
              المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع
              العملية.
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800 py-4 text-center text-xs text-zinc-500">
        روابط فقط — لا تُنزَّل الوسائط على السيرفر أبدًا • إخفاء المفاتيح إلزامي في كل الاستجابات
      </footer>
    </div>
  );
}

/* ============================ مكوّنات فرعية ============================ */

function KeyStatusBadge({ status }: { status: KeyItem["status"] }) {
  if (status === "active") {
    return <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/40" variant="outline">نشط</Badge>;
  }
  if (status === "exhausted") {
    return <Badge className="bg-amber-500/15 text-amber-300 border border-amber-500/40" variant="outline">مستنزف</Badge>;
  }
  return <Badge className="bg-zinc-700/40 text-zinc-400 border border-zinc-600/40" variant="outline">معطّل</Badge>;
}

function TaskStatusBadge({ status }: { status: TaskItem["status"] }) {
  const map: Record<string, { text: string; cls: string }> = {
    completed: { text: "مكتملة", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40" },
    failed: { text: "فاشلة", cls: "bg-red-500/15 text-red-300 border-red-500/40" },
    processing: { text: "جارية", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
    pending: { text: "بالانتظار", cls: "bg-amber-500/15 text-amber-300 border-amber-500/40" },
  };
  const s = map[status] ?? map.pending;
  return <Badge variant="outline" className={s.cls}>{s.text}</Badge>;
}

function StatChip({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <Badge variant="outline" className={`${cls} px-3 py-1`}>
      {label}: <span className="font-bold ms-1">{value}</span>
    </Badge>
  );
}

function TabsDemo({ configs, onCopy }: { configs: { chatgpt: string; claude: string; cursor: string }; onCopy: (t: string) => void }) {
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const labels: Record<typeof tab, string> = {
    chatgpt: "ChatGPT / GPT Agents",
    claude: "Claude Desktop",
    cursor: "Cursor / Windsurf / Cline",
  };
  const notes: Record<typeof tab, string> = {
    chatgpt: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    claude: "انسخه إلى ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
    cursor: "انسخه إلى mcp.json (Settings → MCP) ثم أعد تشغيل المحرر.",
  };
  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden">
      <div className="flex flex-wrap border-b border-zinc-800 bg-zinc-900/70">
        {(Object.keys(labels) as Array<typeof tab>).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-xs font-semibold transition-colors ${
              tab === key ? "bg-emerald-500/10 text-emerald-300 border-b-2 border-emerald-400" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {labels[key]}
          </button>
        ))}
      </div>
      <div className="p-4 space-y-2">
        <p className="text-xs text-zinc-400">{notes[tab]}</p>
        <div className="relative">
          <pre dir="ltr" className="text-[11px] leading-relaxed font-mono bg-zinc-950 border border-zinc-800 rounded p-3 overflow-x-auto text-left text-zinc-300">
            {configs[tab]}
          </pre>
          <Button size="sm" variant="outline" className="absolute top-2 right-2 h-7 text-[11px] border-zinc-700 bg-zinc-900" onClick={() => onCopy(configs[tab])}>
            نسخ
          </Button>
        </div>
      </div>
    </div>
  );
}
