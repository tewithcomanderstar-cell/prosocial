import { z } from "zod";
import { User } from "@/models/User";
import { createSession, hashPassword } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { logAction } from "@/lib/services/logging";

const schema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  timezone: z.string().optional(),
  locale: z.string().optional()
});

export async function POST(request: Request) {
  try {
    await connectDb();
    const payload = parseBody(schema, await request.json());

    const existing = await User.findOne({ email: payload.email });
    if (existing) {
      return jsonError("Email already exists", 409);
    }

    const user = await User.create({
      name: payload.name,
      email: payload.email,
      passwordHash: await hashPassword(payload.password),
      provider: "credentials",
      providerId: null,
      avatar: null,
      role: "admin",
      timezone: payload.timezone ?? "Asia/Bangkok",
      locale: payload.locale ?? "th-TH"
    });

    await createSession(String(user._id));
    await logAction({
      userId: String(user._id),
      type: "auth",
      level: "success",
      message: "Account created successfully",
      metadata: { provider: "credentials", email: payload.email }
    });
    return jsonOk({ userId: String(user._id) }, "Account created successfully");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to register");
  }
}
