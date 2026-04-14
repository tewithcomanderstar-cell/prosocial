import { DateTime } from "luxon";
import { ScheduleFrequency } from "@/lib/types";

export function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

export function computeNextRunAt(
  frequency: ScheduleFrequency,
  runAt: string,
  current = new Date(),
  intervalHours = 1,
  timezone = "UTC"
) {
  const baseUtc = DateTime.fromJSDate(new Date(runAt), { zone: "utc" });
  const currentInZone = DateTime.fromJSDate(current, { zone: "utc" }).setZone(timezone);
  const baseInZone = baseUtc.setZone(timezone);

  if (frequency === "once") {
    return baseUtc.toJSDate();
  }

  if (frequency === "hourly") {
    return currentInZone
      .plus({ hours: Math.max(1, intervalHours) })
      .set({ second: 0, millisecond: 0 })
      .toUTC()
      .toJSDate();
  }

  if (frequency === "daily") {
    return currentInZone
      .plus({ days: 1 })
      .set({
        hour: baseInZone.hour,
        minute: baseInZone.minute,
        second: 0,
        millisecond: 0
      })
      .toUTC()
      .toJSDate();
  }

  return currentInZone
    .plus({ weeks: 1 })
    .set({
      hour: baseInZone.hour,
      minute: baseInZone.minute,
      second: 0,
      millisecond: 0
    })
    .toUTC()
    .toJSDate();
}

export function toUtcDateFromLocal(localDateTime: string, timezone: string) {
  const parsed = DateTime.fromISO(localDateTime, { zone: timezone });
  if (!parsed.isValid) {
    throw new Error("Invalid scheduled time");
  }

  return parsed.toUTC().toJSDate();
}

export function isDue(runAt: Date) {
  return runAt.getTime() <= Date.now();
}
