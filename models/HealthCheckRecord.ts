import { Schema, model, models } from "mongoose";

const healthCheckRecordSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    target: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["healthy", "warning", "down"],
      required: true,
      index: true
    },
    message: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const HealthCheckRecord = models.HealthCheckRecord || model("HealthCheckRecord", healthCheckRecordSchema);
