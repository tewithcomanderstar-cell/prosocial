import mongoose from "mongoose";
import { traceExternalRequest } from "@/lib/services/request-debug";

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: {
    conn: typeof mongoose | null;
    promise: Promise<typeof mongoose> | null;
  } | undefined;
}

const cached = global.mongooseCache ?? {
  conn: null,
  promise: null
};

global.mongooseCache = cached;

function envMs(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function connectDb() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("MONGODB_URI is not configured");
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = traceExternalRequest(
      {
        step: "DATABASE_CONNECT",
        url: "mongodb://[redacted]",
        fn: "connectDb",
        source: "database",
        metadata: {
          dbName: "facebook-auto-posting",
          serverSelectionTimeoutMS: envMs("MONGODB_SERVER_SELECTION_TIMEOUT_MS", 4000),
          connectTimeoutMS: envMs("MONGODB_CONNECT_TIMEOUT_MS", 4000)
        }
      },
      () => mongoose.connect(uri, {
        dbName: "facebook-auto-posting",
        serverSelectionTimeoutMS: envMs("MONGODB_SERVER_SELECTION_TIMEOUT_MS", 4000),
        connectTimeoutMS: envMs("MONGODB_CONNECT_TIMEOUT_MS", 4000),
        socketTimeoutMS: envMs("MONGODB_SOCKET_TIMEOUT_MS", 15000),
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE ?? 8)
      })
    );
  }

  try {
    cached.conn = await cached.promise;
    return cached.conn;
  } catch (error) {
    cached.promise = null;
    throw error;
  }
}
