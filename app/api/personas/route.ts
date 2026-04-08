import { z } from "zod";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { logAction } from "@/lib/services/logging";
import { PagePersona } from "@/models/PagePersona";

const schema = z.object({
  pageId: z.string().min(1),
  pageName: z.string().optional(),
  timezone: z.string().default("Asia/Bangkok"),
  locale: z.string().default("th-TH"),
  tone: z.string().min(2),
  contentStyle: z.string().min(2),
  audience: z.string().min(2),
  promptNotes: z.string().default(""),
  active: z.boolean().default(true)
});

export async function GET() {
  try {
    const userId = await requireAuth();
    const personas = await PagePersona.find({ userId }).sort({ updatedAt: -1 }).lean();
    return jsonOk({ personas });
  } catch {
    return jsonError("Unauthorized", 401);
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const persona = await PagePersona.findOneAndUpdate(
      { userId, pageId: payload.pageId },
      payload,
      { upsert: true, new: true }
    ).lean();

    await logAction({
      userId,
      type: "settings",
      level: "success",
      message: `Persona saved for page ${payload.pageId}`,
      metadata: payload
    });

    return jsonOk({ persona }, "Persona saved");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to save persona");
  }
}
