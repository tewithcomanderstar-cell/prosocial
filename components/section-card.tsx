"use client";

import { ReactNode } from "react";
import { AppIcon, AppIconName } from "@/components/app-icon";
import { Tooltip } from "@/components/tooltip";

type SectionCardProps = {
  title: string;
  icon?: AppIconName;
  tooltip?: string;
  action?: ReactNode;
  children: ReactNode;
};

export function SectionCard({ title, icon, tooltip, action, children }: SectionCardProps) {
  return (
    <section className="card section-card">
      <div className="section-head">
        <div className="section-title-wrap">
          {icon ? <AppIcon name={icon} className="section-icon" /> : null}
          <h2>{title}</h2>
          {tooltip ? (
            <Tooltip content={tooltip}>
              <span className="tooltip-trigger" aria-label={tooltip}>i</span>
            </Tooltip>
          ) : null}
        </div>
        {action}
      </div>
      <div className="stack">{children}</div>
    </section>
  );
}
