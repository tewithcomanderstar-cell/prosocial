"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type ScheduleItem = {
  _id: string;
  postId: string;
  frequency: string;
  intervalHours?: number;
  nextRunAt: string;
  lastRunAt?: string;
  enabled: boolean;
  timezone: string;
};

type PostItem = {
  _id: string;
  title: string;
};

export function ScheduleTable() {
  const { t, language } = useI18n();
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([fetch("/api/schedules").then((res) => res.json()), fetch("/api/posts").then((res) => res.json())])
      .then(([scheduleResult, postResult]) => {
        if (!scheduleResult.ok) {
          setError(t("scheduleLoginToView"));
          return;
        }

        setSchedules(scheduleResult.data.schedules);
        if (postResult.ok) {
          setPosts(postResult.data.posts);
        }
      })
      .catch(() => setError(t("commonRequestFailed")));
  }, [t]);

  if (error) {
    return <p className="muted">{error}</p>;
  }

  if (schedules.length === 0) {
    return <p className="muted">{t("scheduleNoData")}</p>;
  }

  const locale = language === "th" ? "th-TH" : "en-US";
  const postMap = new Map(posts.map((post) => [post._id, post.title]));

  function formatFrequency(schedule: ScheduleItem) {
    if (schedule.frequency === "hourly") {
      return language === "th"
        ? `ทุก ${schedule.intervalHours ?? 1} ชั่วโมง`
        : `Every ${schedule.intervalHours ?? 1} hour(s)`;
    }

    const frequencyMap = {
      once: t("scheduleOneTime"),
      daily: t("scheduleEveryDay"),
      weekly: t("scheduleEveryWeek")
    } as const;

    return frequencyMap[schedule.frequency as keyof typeof frequencyMap] || schedule.frequency;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{t("schedulePost")}</th>
          <th>{t("scheduleFrequency")}</th>
          <th>{t("scheduleNextRun")}</th>
          <th>{t("scheduleLastRun")}</th>
          <th>{t("scheduleStatus")}</th>
        </tr>
      </thead>
      <tbody>
        {schedules.map((schedule) => (
          <tr key={schedule._id}>
            <td>{postMap.get(schedule.postId) || t("scheduleUnknownPost")}</td>
            <td>{formatFrequency(schedule)}</td>
            <td>{new Date(schedule.nextRunAt).toLocaleString(locale, { timeZone: schedule.timezone })}</td>
            <td>
              {schedule.lastRunAt ? new Date(schedule.lastRunAt).toLocaleString(locale, { timeZone: schedule.timezone }) : "-"}
            </td>
            <td>{schedule.enabled ? t("scheduleActive") : t("schedulePaused")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
