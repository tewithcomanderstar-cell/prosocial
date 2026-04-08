import { z } from "zod";
import { generateFacebookContent } from "@/lib/services/ai";
import { jsonError, jsonOk, parseBody, requireAuth } from "@/lib/api";
import { PagePersona } from "@/models/PagePersona";

type PersonaContext = {
  pageName?: string;
  tone?: string;
  contentStyle?: string;
  audience?: string;
  promptNotes?: string;
};

const schema = z.object({
  keyword: z.string().min(2),
  pageId: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const userId = await requireAuth();
    const payload = parseBody(schema, await request.json());
    const persona = payload.pageId
      ? ((await PagePersona.findOne({ userId, pageId: payload.pageId, active: true }).lean()) as PersonaContext | null)
      : null;
    const variants = await generateFacebookContent(payload.keyword, persona ?? undefined, userId);
    return jsonOk({ variants, persona });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to generate content");
  }
}

