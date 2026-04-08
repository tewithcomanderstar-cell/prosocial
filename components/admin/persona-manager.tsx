"use client";

import { FormEvent, useEffect, useState } from "react";

type Persona = {
  _id?: string;
  pageId: string;
  pageName?: string;
  tone: string;
  contentStyle: string;
  audience: string;
  promptNotes: string;
  active: boolean;
};

const emptyPersona: Persona = {
  pageId: "",
  pageName: "",
  tone: "professional",
  contentStyle: "sales",
  audience: "general audience",
  promptNotes: "",
  active: true
};

export function PersonaManager() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [form, setForm] = useState<Persona>(emptyPersona);
  const [message, setMessage] = useState("");

  async function load() {
    const response = await fetch("/api/personas");
    const result = await response.json();
    if (result.ok) {
      setPersonas(result.data.personas);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/personas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    const result = await response.json();
    setMessage(result.ok ? "Persona saved" : result.message || "Unable to save persona");
    if (result.ok) {
      setForm(emptyPersona);
      load();
    }
  }

  return (
    <div className="stack page-stack">
      <section className="card">
        <form className="form" onSubmit={handleSubmit}>
          <div className="grid cols-2">
            <label className="label">Page ID<input className="input" value={form.pageId} onChange={(e) => setForm({ ...form, pageId: e.target.value })} required /></label>
            <label className="label">Page Name<input className="input" value={form.pageName} onChange={(e) => setForm({ ...form, pageName: e.target.value })} /></label>
            <label className="label">Tone<input className="input" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} required /></label>
            <label className="label">Style<input className="input" value={form.contentStyle} onChange={(e) => setForm({ ...form, contentStyle: e.target.value })} required /></label>
            <label className="label">Audience<input className="input" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} required /></label>
            <label className="label">Status<select className="select" value={form.active ? "true" : "false"} onChange={(e) => setForm({ ...form, active: e.target.value === "true" })}><option value="true">Active</option><option value="false">Paused</option></select></label>
          </div>
          <label className="label">Notes<textarea className="textarea" value={form.promptNotes} onChange={(e) => setForm({ ...form, promptNotes: e.target.value })} /></label>
          <button className="button" type="submit">Save Persona</button>
          {message ? <p className="muted">{message}</p> : null}
        </form>
      </section>

      <section className="card">
        <div className="section-head"><div><h2>Profiles</h2></div></div>
        <div className="list">
          {personas.map((persona) => (
            <div key={persona._id ?? persona.pageId} className="list-item">
              <strong>{persona.pageName || persona.pageId}</strong>
              <span className="badge badge-neutral">{persona.active ? "Active" : "Paused"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
