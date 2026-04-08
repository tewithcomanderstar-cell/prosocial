import { Schema, model, models } from "mongoose";

const teamMemberSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: { type: String, enum: ["admin", "editor", "viewer"], default: "viewer", index: true },
    assignedPages: { type: [String], default: [] },
    assignedTaskCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

teamMemberSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const TeamMember = models.TeamMember || model("TeamMember", teamMemberSchema);
