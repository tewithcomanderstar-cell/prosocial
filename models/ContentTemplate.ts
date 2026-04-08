import { Schema, model, models } from "mongoose";

const contentTemplateSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    category: { type: String, required: true, index: true },
    bodyTemplate: { type: String, required: true },
    hashtagTemplate: { type: [String], default: [] },
    placeholders: { type: [String], default: [] },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

export const ContentTemplate = models.ContentTemplate || model("ContentTemplate", contentTemplateSchema);
