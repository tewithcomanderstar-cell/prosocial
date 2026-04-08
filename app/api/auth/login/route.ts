import { z } from "zod";
import { User } from "@/models/User";
import { comparePassword, createSession } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { jsonError, jsonOk, parseBody } from "@/lib/api";
import { logAction } from "@/lib/services/logging";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

export async function POST(request: Request) {
  try {
    await connectDb();
    const payload = parseBody(schema, await request.json());

    const user = await User.findOne({ email: payload.email });
    if (!user || !user.passwordHash) {
      return jsonError("Invalid credentials", 401);
    }

    const isValid = await comparePassword(payload.password, user.passwordHash);
    if (!isValid) {
      await logAction({
        userId: String(user._id),
        type: "auth",
        level: "warn",
        message: "Login failed because credentials were invalid",
        metadata: { email: payload.email }
      });
      return jsonError("Invalid credentials", 401);
    }

    await createSession(String(user._id));
    await logAction({
      userId: String(user._id),
      type: "auth",
      level: "success",
      message: "User login successful",
      metadata: { provider: "credentials" }
    });
    return jsonOk({ userId: String(user._id) }, "Login successful");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Unable to login");
  }
}
