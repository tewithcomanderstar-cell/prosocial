"use client";

import { useEffect, useState } from "react";

type LogItem = {
  _id: string;
  type: string;
  level: string;
  message: string;
  createdAt: string;
};

type JobItem = {
  _id: string;
  type: string;
  status: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
};

type NotificationItem = {
  _id: string;
  severity: string;
  title: string;
  message: string;
  createdAt: string;
};

export function LogsDashboard() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/logs").then((res) => res.json()),
      fetch("/api/jobs").then((res) => res.json()),
      fetch("/api/notifications").then((res) => res.json())
    ]).then(([logsRes, jobsRes, notificationsRes]) => {
      if (logsRes.ok) setLogs(logsRes.data.logs);
      if (jobsRes.ok) setJobs(jobsRes.data.jobs);
      if (notificationsRes.ok) setNotifications(notificationsRes.data.notifications);
    });
  }, []);

  return (
    <div className="stack page-stack">
      <div className="grid cols-3">
        <div className="card stat stat-card">
          <strong>{logs.length}</strong>
          <span>Logs</span>
        </div>
        <div className="card stat stat-card">
          <strong>{jobs.length}</strong>
          <span>Jobs</span>
        </div>
        <div className="card stat stat-card">
          <strong>{notifications.length}</strong>
          <span>Alerts</span>
        </div>
      </div>

      <div className="grid cols-2">
        <section className="card">
          <div className="section-head"><div><h2>Recent Actions</h2></div></div>
          <div className="list">
            {logs.slice(0, 12).map((log) => (
              <div key={log._id} className="list-item">
                <strong>{log.message}</strong>
                <span className="badge badge-neutral">{log.type}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="section-head"><div><h2>Jobs</h2></div></div>
          <div className="list">
            {jobs.slice(0, 12).map((job) => (
              <div key={job._id} className="list-item">
                <strong>{job.type}</strong>
                <span className="badge badge-neutral">{job.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="section-head"><div><h2>Alerts</h2></div></div>
        <div className="list">
          {notifications.slice(0, 10).map((item) => (
            <div key={item._id} className="list-item">
              <strong>{item.title}</strong>
              <span className="badge badge-neutral">{item.severity}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
