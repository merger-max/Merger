/**
 * خادم MCP — media-generator-mcp v1.2.0 — خمس أدوات، ردود عربية.
 * يستخدم McpServer الرسمي + WebStandardStreamableHTTPServerTransport (متوافق مع Next.js/Vercel مباشرة).
 * ملاحظات الردود: مكتملة → رابط جاهز؛ جارية → task_id مع التقدم؛ فاشلة → سبب معقّم (بلا ذكر مفاتيح/رصيد).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  runGeneration,
  runMerge,
  refreshTask,
  formatTaskMessage,
  type ProgressCallback,
} from "./orchestrator";
import { listRecentTasks } from "./turso";
import { MODELS } from "./models";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/** يبث إشعارات التقدم العربية كل بضع ثوانٍ إن زوّد العميل progressToken */
function progressReporter(extra: any): ProgressCallback | undefined {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || progressToken === null) return undefined;
  return async (progress: number, message: string) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total: 100,
          message,
        },
      });
    } catch {
      // العميل غادر أو لا يدعم الإشعارات — نتجاهل بصمت ونستمر
    }
  };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  /* ---------- 1) generate_image ---------- */
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
        "Returns a ready image URL if it finishes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1, "الحقل prompt مطلوب — ما الذي تريد رسمه؟").describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"]).default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"]).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const { prompt, model, aspect_ratio, resolution, background, output_format, wait_seconds } = args;
      try {
        const outcome = await runGeneration({
          type: "image",
          model,
          prompt,
          params: { aspect_ratio, resolution, background, output_format },
          waitSeconds: wait_seconds,
          onProgress: progressReporter(extra),
        });
        if (outcome.kind === "no_keys") {
          return textResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
            true,
          );
        }
        const task = outcome.task;
        return textResult(formatTaskMessage(task), task.status === "failed");
      } catch (err: any) {
        return textResult(`❌ فشلت المهمة: ${String(err?.message ?? err).slice(0, 300)}`, true);
      }
    },
  );

  /* ---------- 2) generate_video ---------- */
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio/dialogue/SFX; optional image-to-video via image_url). " +
        "Video takes minutes: a short wait with live progress is returned first, then a task_id — track it with get_task every ~10 seconds until completed.",
      inputSchema: {
        prompt: z.string().max(4096, "الوصف يتجاوز 4096 حرفًا").describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"]).default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const { prompt, image_url, model, aspect_ratio, resolution, enable_audio, duration, wait_seconds } = args;
      try {
        const outcome = await runGeneration({
          type: "video",
          model,
          prompt,
          params: { image_url, aspect_ratio, resolution, enable_audio, duration },
          waitSeconds: wait_seconds,
          onProgress: progressReporter(extra),
        });
        if (outcome.kind === "no_keys") {
          return textResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
            true,
          );
        }
        const task = outcome.task;
        return textResult(formatTaskMessage(task), task.status === "failed");
      } catch (err: any) {
        return textResult(`❌ فشلت المهمة: ${String(err?.message ?? err).slice(0, 300)}`, true);
      }
    },
  );

  /* ---------- 3) merge_videos ---------- */
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — e.g. links from generate_video) or 'task_ids' (completed video generation tasks; their result URLs are merged in this order). " +
        "Merging is usually fast: a short wait with live progress, then a task_id — track it with get_task. " +
        'IMPORTANT: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.',
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const { urls, task_ids, wait_seconds } = args;
      if ((!urls || urls.length === 0) && (!task_ids || task_ids.length === 0)) {
        return textResult(
          "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
          true,
        );
      }
      try {
        const outcome = await runMerge({
          urls,
          taskIds: task_ids,
          waitSeconds: wait_seconds,
          onProgress: progressReporter(extra),
        });
        if (outcome.kind === "invalid") {
          return textResult(outcome.message, true);
        }
        const task = outcome.task;
        return textResult(formatTaskMessage(task), task.status === "failed");
      } catch (err: any) {
        return textResult(`❌ فشلت المهمة: ${String(err?.message ?? err).slice(0, 300)}`, true);
      }
    },
  );

  /* ---------- 4) get_task ---------- */
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service if still running). " +
        "Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1, "الحقل task_id مطلوب"),
      },
    },
    async (args) => {
      const result = await refreshTask(args.task_id.trim());
      if (!result) {
        return textResult(`❌ لا توجد مهمة بالمعرّف ${args.task_id}. تأكد من المعرّف أو استخدم list_media لعرض المهام المخزنة.`, true);
      }
      return textResult(result.message, result.task.status === "failed");
    },
  );

  /* ---------- 5) list_media ---------- */
  server.registerTool(
    "list_media",
    {
      description:
        "List the most recent images/videos/merges stored in the database with their URLs (no regeneration) — recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, {
        type: args.type,
        status: args.status,
      });
      if (!tasks.length) {
        return textResult("لا توجد مهام مخزنة بعد بأي فلتر مطابق. أنشئ وسائط أولًا بـ generate_image / generate_video.");
      }
      const label: Record<string, string> = {
        image: "صورة",
        video: "فيديو",
        merge: "دمج",
      };
      const statusLabel: Record<string, string> = {
        completed: "مكتملة",
        failed: "فاشلة",
        processing: "جارية",
        pending: "جارية",
      };
      const lines = tasks.map((t, i) => {
        const urls = (() => {
          try {
            return (JSON.parse(t.result_urls_json || "[]") as string[]) ?? [];
          } catch {
            return [] as string[];
          }
        })();
        const head = `${i + 1}. [${label[t.type] ?? t.type} • ${statusLabel[t.status] ?? t.status}] ${t.model} — task_id: ${t.id} — ${t.created_at}`;
        const promptLine = t.prompt ? `   الوصف: ${t.prompt.slice(0, 120)}` : "";
        const urlLines = urls.length ? `   الروابط:\n${urls.map((u) => `   - ${u}`).join("\n")}` : "";
        return [head, promptLine, urlLines].filter(Boolean).join("\n");
      });
      return textResult(`المهام المخزنة (الأحدث أولًا):\n\n${lines.join("\n\n")}`);
    },
  );

  return server;
}
