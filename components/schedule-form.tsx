"use client";

import { FormEvent, useEffect, useState } from "react";
import { useI18n } from "@/components/language-provider";

type PostOption = {
  _id: string;
  title: string;
  status: string;
};

export function ScheduleForm() {
  const { t, language } = useI18n();
  const isThai = language === "th";
  const [posts, setPosts] = useState<PostOption[]>([]);
  const [message, setMessage] = useState("");
  const [frequency, setFrequency] = useState("once");
  const [startMode, setStartMode] = useState("scheduled");
  const [intervalHours, setIntervalHours] = useState(1);
  const [delayMinutes, setDelayMinutes] = useState(0);

  useEffect(() => {
    fetch("/api/posts")
      .then((res) => res.json())
      .then((result) => {
        if (result.ok) {
          setPosts(result.data.posts);
        }
      });
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const localRunAt = String(formData.get("runAt") || "");
    const payload = {
      postId: String(formData.get("postId") || ""),
      frequency,
      runAt: localRunAt ? new Date(localRunAt).toISOString() : undefined,
      timezone: String(formData.get("timezone") || "Asia/Bangkok"),
      intervalHours,
      delayMinutes,
      startMode
    };

    const response = await fetch("/api/schedules", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    setMessage(result.message || (result.ok ? t("commonSuccess") : t("commonRequestFailed")));
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <label className="label">
        {t("schedulePost")}
        <select className="select" name="postId" required>
          <option value="">{t("commonSelectPost")}</option>
          {posts.map((post) => (
            <option key={post._id} value={post._id}>
              {post.title} ({post.status})
            </option>
          ))}
        </select>
      </label>

      <label className="label">
        {isThai ? "โหมดเริ่มต้น" : "Start mode"}
        <select className="select" value={startMode} onChange={(e) => setStartMode(e.target.value)}>
          <option value="scheduled">{isThai ? "เลือกเวลาเอง" : "Pick a specific time"}</option>
          <option value="delay">{isThai ? "เริ่มหลังหน่วงเวลา" : "Start after delay"}</option>
        </select>
      </label>

      {startMode === "scheduled" ? (
        <label className="label">
          {t("scheduleTime")}
          <input className="input" name="runAt" type="datetime-local" required />
        </label>
      ) : (
        <label className="label">
          {isThai ? "หน่วงเวลาก่อนเริ่ม (นาที)" : "Delay before first post (minutes)"}
          <input className="input" type="number" min="0" value={delayMinutes} onChange={(e) => setDelayMinutes(Number(e.target.value))} />
        </label>
      )}

      <label className="label">
        {t("scheduleFrequency")}
        <select className="select" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
          <option value="once">{t("scheduleOneTime")}</option>
          <option value="hourly">{isThai ? "ทุก X ชั่วโมง" : "Every X hours"}</option>
          <option value="daily">{t("scheduleEveryDay")}</option>
          <option value="weekly">{t("scheduleEveryWeek")}</option>
        </select>
      </label>

      {frequency === "hourly" ? (
        <label className="label">
          {isThai ? "ทุกกี่ชั่วโมง" : "Repeat every how many hours"}
          <select className="select" value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))}>
            <option value="1">1 {isThai ? "ชั่วโมง" : "hour"}</option>
            <option value="2">2 {isThai ? "ชั่วโมง" : "hours"}</option>
            <option value="3">3 {isThai ? "ชั่วโมง" : "hours"}</option>
          </select>
        </label>
      ) : null}

      <label className="label">
        {t("scheduleTimezone")}
        <input className="input" name="timezone" defaultValue="Asia/Bangkok" required />
      </label>

      <button className="button" type="submit">
        {t("scheduleCreateButton")}
      </button>

      {message ? <p className="muted">{message}</p> : null}
    </form>
  );
}
