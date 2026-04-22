import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { TrendTrackedPage } from "@/models/TrendTrackedPage";

const patchSchema = z.object({
  pageName: z.string().min(1).optional(),
  category: z.string().optional(),
  priorityWeight: z.coerce.number().min(0).max(10).optional(),
  trustWeight: z.coerce.number().min(0).max(10).optional(),
  active: z.boolean().optional()
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    const payload = parseBody(patchSchema, await request.json());
    const page = await TrendTrackedPage.findOneAndUpdate({ _id: id, userId }, payload, { new: true }).lean();
    if (!page) {
      return jsonError("??????????????????", 404);
    }
    return jsonOk({ page }, "???????????????????????");
  } catch (error) {
    return handleRoleError(error);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    await TrendTrackedPage.findOneAndDelete({ _id: id, userId });
    return jsonOk({ deleted: true }, "???????????????????");
  } catch (error) {
    return handleRoleError(error);
  }
}
