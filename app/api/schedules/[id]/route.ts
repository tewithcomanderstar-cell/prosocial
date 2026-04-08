import { z } from "zod";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { handleRoleError, requireRole } from "@/lib/services/permissions";
import { Schedule } from "@/models/Schedule";

const schema = z.object({
  nextRunAt: z.string().min(1)
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireRole(["admin", "editor"]);
    const { id } = await context.params;
    const payload = parseBody(schema, await request.json());

    const schedule = await Schedule.findOneAndUpdate(
      { _id: id, userId },
      { nextRunAt: new Date(payload.nextRunAt), runAt: new Date(payload.nextRunAt) },
      { new: true }
    ).lean();

    if (!schedule) {
      return jsonError("Schedule not found", 404);
    }

    return jsonOk({ schedule }, "Schedule moved");
  } catch (error) {
    return handleRoleError(error);
  }
}
