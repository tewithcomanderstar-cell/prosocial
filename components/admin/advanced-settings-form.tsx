"use client";

import { FormEvent, useEffect, useState } from "react";

type SettingsState = {
  hourlyPostLimit: number;
  dailyPostLimit: number;
  commentHourlyLimit: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  duplicateWindowHours: number;
  randomizationLevel: "low" | "medium" | "high";
  autoCommentEnabled: boolean;
  apiBurstWindowMs: number;
  apiBurstMax: number;
  notifyOnError: boolean;
  tokenExpiryWarningHours: number;
};

const defaults: SettingsState = {
  hourlyPostLimit: 10,
  dailyPostLimit: 0,
  commentHourlyLimit: 20,
  minDelaySeconds: 15,
  maxDelaySeconds: 90,
  duplicateWindowHours: 24,
  randomizationLevel: "medium",
  autoCommentEnabled: false,
  apiBurstWindowMs: 60000,
  apiBurstMax: 20,
  notifyOnError: true,
  tokenExpiryWarningHours: 72
};

export function AdvancedSettingsForm() {
  const [state, setState] = useState<SettingsState>(defaults);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok?.valueOf && result.ok) {
          setState({ ...defaults, ...result.data.settings });
        }
      });
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    const result = await response.json();
    setMessage(result.ok ? "Settings saved" : result.message || "Unable to save settings");
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="grid cols-2">
        <label className="label">Hourly post limit<input className="input" type="number" value={state.hourlyPostLimit} onChange={(e) => setState({ ...state, hourlyPostLimit: Number(e.target.value) })} /></label>
        <label className="label">Daily post limit (0 = unlimited)<input className="input" type="number" value={state.dailyPostLimit} onChange={(e) => setState({ ...state, dailyPostLimit: Number(e.target.value) })} /></label>
        <label className="label">Comment hourly limit<input className="input" type="number" value={state.commentHourlyLimit} onChange={(e) => setState({ ...state, commentHourlyLimit: Number(e.target.value) })} /></label>
        <label className="label">Min random delay (sec)<input className="input" type="number" value={state.minDelaySeconds} onChange={(e) => setState({ ...state, minDelaySeconds: Number(e.target.value) })} /></label>
        <label className="label">Max random delay (sec)<input className="input" type="number" value={state.maxDelaySeconds} onChange={(e) => setState({ ...state, maxDelaySeconds: Number(e.target.value) })} /></label>
        <label className="label">Duplicate window (hours)<input className="input" type="number" value={state.duplicateWindowHours} onChange={(e) => setState({ ...state, duplicateWindowHours: Number(e.target.value) })} /></label>
        <label className="label">API burst window (ms)<input className="input" type="number" value={state.apiBurstWindowMs} onChange={(e) => setState({ ...state, apiBurstWindowMs: Number(e.target.value) })} /></label>
        <label className="label">API burst max<input className="input" type="number" value={state.apiBurstMax} onChange={(e) => setState({ ...state, apiBurstMax: Number(e.target.value) })} /></label>
        <label className="label">Token warning (hours)<input className="input" type="number" value={state.tokenExpiryWarningHours} onChange={(e) => setState({ ...state, tokenExpiryWarningHours: Number(e.target.value) })} /></label>
        <label className="label">Randomization level<select className="select" value={state.randomizationLevel} onChange={(e) => setState({ ...state, randomizationLevel: e.target.value as SettingsState["randomizationLevel"] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      </div>

      <label className="list-item"><span>Enable auto comment</span><input type="checkbox" checked={state.autoCommentEnabled} onChange={(e) => setState({ ...state, autoCommentEnabled: e.target.checked })} /></label>
      <label className="list-item"><span>Notify on error</span><input type="checkbox" checked={state.notifyOnError} onChange={(e) => setState({ ...state, notifyOnError: e.target.checked })} /></label>
      <button className="button" type="submit">Save advanced settings</button>
      {message ? <p className="muted">{message}</p> : null}
    </form>
  );
}
