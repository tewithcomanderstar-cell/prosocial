import { Schema, model, models } from "mongoose";

const setupStepStateSchema = new Schema(
  {
    key: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "loading", "success", "error"],
      default: "pending"
    },
    title: { type: String, default: "" },
    message: { type: String, default: "" },
    rootCause: { type: String, default: "" },
    fixActionKey: { type: String, default: "" },
    fixActionLabel: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const setupSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["not_started", "in_progress", "completed"],
      default: "not_started"
    },
    currentStep: { type: String, default: "facebook" },
    completedSteps: { type: [String], default: [] },
    stepData: { type: Schema.Types.Mixed, default: {} },
    steps: { type: [setupStepStateSchema], default: [] },
    lastError: { type: String, default: "" },
    startedAt: { type: Date },
    completedAt: { type: Date },
    lastVisitedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const SetupSession = models.SetupSession || model("SetupSession", setupSessionSchema);
