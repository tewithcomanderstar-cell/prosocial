"use client";

import { useEffect, useState } from "react";

type Member = { _id: string; role: string; assignedPages?: string[]; assignedTaskCount?: number; userId?: string };
type Workspace = { _id: string; name: string; slug: string; plan: string; pageLimit: number; timezone: string };
type Approval = { _id: string; postId: string; status: string; note?: string };

export function TeamWorkspacePanel() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

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

  return (
    <div className="stack">
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
          {members.map((member) => (
            <div key={member._id} className="list-item">
              <div>
                <strong>{member.userId}</strong>
                <div className="muted">{(member.assignedPages ?? []).join(", ") || "None"}</div>
              </div>
              <span className="badge">{member.role}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
