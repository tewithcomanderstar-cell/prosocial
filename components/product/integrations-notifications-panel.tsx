"use client";

import { useEffect, useState } from "react";

type Integration = { _id: string; provider: string; status: string };
type Channel = { _id: string; channelType: string; target: string; enabled: boolean };

export function IntegrationsNotificationsPanel() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/integrations").then((res) => res.json()),
      fetch("/api/notification-channels").then((res) => res.json())
    ]).then(([integrationsRes, channelsRes]) => {
      if (integrationsRes.ok) setIntegrations(integrationsRes.data.integrations);
      if (channelsRes.ok) setChannels(channelsRes.data.channels);
    });
  }, []);

  return (
    <div className="grid cols-2">
      <section className="card">
        <div className="section-head"><div><h2>Integrations</h2></div></div>
        <div className="list">
          {integrations.map((item) => (
            <div key={item._id} className="list-item">
              <span>{item.provider}</span>
              <span className="badge">{item.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-head"><div><h2>Notifications</h2></div></div>
        <div className="list">
          {channels.map((item) => (
            <div key={item._id} className="list-item">
              <div>
                <strong>{item.channelType}</strong>
                <div className="muted">{item.target}</div>
              </div>
              <span className="badge">{item.enabled ? "enabled" : "paused"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
