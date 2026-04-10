"use client";

import { useEffect, useMemo, useState } from "react";

type Member = { _id: string; role: string; assignedPages?: string[]; assignedTaskCount?: number; userId?: string; workspaceId?: string };
type Workspace = { _id: string; name: string; slug: string; plan: string; pageLimit: number; timezone: string };
type Approval = { _id: string; postId: string; status: string; note?: string };

export function TeamWorkspacePanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingMemberId, setDeletingMemberId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/workspaces").then((res) => res.json()),
      fetch("/api/team-members").then((res) => res.json()),
      fetch("/api/approvals").then((res) => res.json())
    ]).then(([workspaceRes, membersRes, approvalsRes]) => {
      if (workspaceRes.ok) setWorkspaces(workspaceRes.data.workspaces);
      if (membersRes.ok) setMembers(membersRes.data.members);
      if (approvalsRes.ok) setApprovals(approvalsRes.data.approvals);
    });
  }, []);

  const workspaceById = useMemo(() => {
    return new Map(workspaces.map((workspace) => [String(workspace._id), workspace]));
  }, [workspaces]);

  async function handleDeleteMember(member: Member) {
    const label = member.userId || "this member";
    const confirmed = window.confirm(`Remove ${label} from this workspace?`);
    if (!confirmed) return;

    setDeletingMemberId(member._id);
    setFeedback(null);
    setError(null);

    try {
      const response = await fetch(`/api/team-members?id=${encodeURIComponent(member._id)}`, {
        method: "DELETE"
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "Unable to remove team member");
      }

      setMembers((current) => current.filter((currentMember) => currentMember._id !== member._id));
      setFeedback("Team member removed");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Unable to remove team member");
    } finally {
      setDeletingMemberId(null);
    }
  }

  return (
    <div className="stack">
      {feedback ? <div className="composer-message">{feedback}</div> : null}
      {error ? <div className="composer-message composer-message-error">{error}</div> : null}

      <div className="grid cols-2">
        <section className="card">
          <div className="section-head"><div><h2>Workspaces</h2></div></div>
          <div className="list">
            {workspaces.map((workspace) => (
              <div key={workspace._id} className="list-item">
                <div>
                  <strong>{workspace.name}</strong>
                  <div className="muted">{workspace.slug} · {workspace.plan}</div>
                </div>
                <span className="badge">Pages {workspace.pageLimit}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="section-head"><div><h2>Approvals</h2></div></div>
          <div className="list">
            {approvals.map((approval) => (
              <div key={approval._id} className="list-item">
                <div>
                  <strong>{approval.postId}</strong>
                  <div className="muted">{approval.note || "No note"}</div>
                </div>
                <span className="badge">{approval.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head"><div><h2>Team</h2></div></div>
        <div className="list">
          {members.map((member) => {
            const workspace = member.workspaceId ? workspaceById.get(String(member.workspaceId)) : null;
            const isDeleting = deletingMemberId === member._id;

            return (
              <div key={member._id} className="list-item team-member-item">
                <div>
                  <strong>{member.userId}</strong>
                  <div className="muted">{(member.assignedPages ?? []).join(", ") || "None"}</div>
                  <div className="muted">{workspace ? `Workspace: ${workspace.name}` : "Workspace: -"}</div>
                </div>
                <div className="team-member-actions">
                  <span className="badge">{member.role}</span>
                  <button
                    type="button"
                    className="button-secondary danger-button"
                    onClick={() => handleDeleteMember(member)}
                    disabled={isDeleting}
                  >
                    {isDeleting ? "Removing..." : "Remove"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
