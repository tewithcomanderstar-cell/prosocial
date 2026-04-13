import { z } from "zod";
import { NextResponse } from "next/server";
import { User } from "@/models/User";
import { attachSessionCookie, hashPassword } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { jsonError, parseBody } from "@/lib/api";
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

    const response = NextResponse.json({
      ok: true,
      message: "Account created successfully",
      data: { userId: String(user._id) }
    });

    await attachSessionCookie(response, String(user._id));
    await logAction({
      userId: String(user._id),
      type: "auth",
      level: "success",
      message: "Account created successfully",
      metadata: { provider: "credentials", email: payload.email }
    });
    return response;
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to register");
  }
}
