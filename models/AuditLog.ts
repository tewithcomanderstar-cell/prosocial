import { Schema, model, models } from "mongoose";

const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    metadataJson: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const AuditLog = models.AuditLog || model("AuditLog", auditLogSchema);
