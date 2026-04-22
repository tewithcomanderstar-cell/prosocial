import { Schema, model, models } from "mongoose";

const trendRssNewsConfigSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    autoRunEnabled: { type: Boolean, default: false },
    intervalMinutes: { type: Number, enum: [30, 60, 120], default: 60 },
    autoPostEnabled: { type: Boolean, default: false },
    autoPostIntervalMinutes: { type: Number, enum: [30, 60, 120], default: 60 },
    destinationPageIds: { type: [String], default: [] },
    strategyGoal: {
      type: String,
      enum: ["maximize_shares", "maximize_time_spend", "maximize_engagement", "maximize_trust"],
      default: "maximize_time_spend"
    },
    safeDraftMode: { type: Boolean, default: true },
    templateId: { type: String, default: null },
    status: {
      type: String,
      enum: ["idle", "running", "waiting", "failed"],
      default: "idle",
      index: true
    },
    lastScanAt: { type: Date, default: null },
    nextScanAt: { type: Date, default: null, index: true },
    lastAutoPostAt: { type: Date, default: null },
    nextAutoPostAt: { type: Date, default: null, index: true },
    lastRunAt: { type: Date, default: null },
    nextRunAt: { type: Date, default: null, index: true },
    lastError: { type: String, default: null },
    lastDraftId: { type: Schema.Types.ObjectId, ref: "ContentItem", default: null }
  },
  { timestamps: true }
);

export const TrendRssNewsConfig =
  models.TrendRssNewsConfig || model("TrendRssNewsConfig", trendRssNewsConfigSchema);
