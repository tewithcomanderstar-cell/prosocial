"use client";

import { useEffect, useState } from "react";

type Template = { _id: string; name: string; category: string; bodyTemplate: string; hashtagTemplate?: string[] };
type HashtagSet = { _id: string; name: string; category: string; hashtags: string[] };

export function TemplateHashtagManager() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [sets, setSets] = useState<HashtagSet[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/templates").then((res) => res.json()),
      fetch("/api/hashtags").then((res) => res.json())
    ]).then(([templatesRes, hashtagsRes]) => {
      if (templatesRes.ok) setTemplates(templatesRes.data.templates);
      if (hashtagsRes.ok) setSets(hashtagsRes.data.sets);
    });
  }, []);

  return (
    <div className="grid cols-2">
      <section className="card">
        <div className="section-head"><div><h2>Templates</h2></div></div>
        <div className="list">
          {templates.map((template) => (
            <div key={template._id} className="list-item">
              <div>
                <strong>{template.name}</strong>
                <div className="muted">{template.category}</div>
                <div className="muted">{template.bodyTemplate}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-head"><div><h2>Hashtags</h2></div></div>
        <div className="list">
          {sets.map((set) => (
            <div key={set._id} className="list-item">
              <div>
                <strong>{set.name}</strong>
                <div className="muted">{set.category}</div>
                <div className="muted">{set.hashtags.join(" ")}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
