import { Schema, model, models } from "mongoose";

const pagePersonaSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    pageId: { type: String, required: true, index: true },
    pageName: { type: String },
    timezone: { type: String, default: "Asia/Bangkok" },
    locale: { type: String, default: "th-TH" },
    tone: { type: String, default: "professional" },
    contentStyle: { type: String, default: "sales" },
    audience: { type: String, default: "general audience" },
    promptNotes: { type: String, default: "" },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

pagePersonaSchema.index({ userId: 1, pageId: 1 }, { unique: true });

export const PagePersona = models.PagePersona || model("PagePersona", pagePersonaSchema);
