import { Schema, model, models } from "mongoose";

const backupSnapshotSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["export", "import", "backup", "restore"],
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ["completed", "failed"],
      required: true,
      index: true
    },
    fileName: { type: String },
    note: { type: String },
    itemCounts: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const BackupSnapshot = models.BackupSnapshot || model("BackupSnapshot", backupSnapshotSchema);
