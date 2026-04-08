import { ScheduleFrequency } from "@/lib/types";

export function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

export function computeNextRunAt(
  frequency: ScheduleFrequency,
  runAt: string,
  current = new Date(),
  intervalHours = 1
) {
  const base = new Date(runAt);

  if (frequency === "once") {
    return base;
  }

  const next = new Date(current);
  next.setSeconds(0, 0);

  if (frequency === "hourly") {
    next.setTime(next.getTime() + Math.max(1, intervalHours) * 60 * 60 * 1000);
    return next;
  }

  if (frequency === "daily") {
    next.setDate(next.getDate() + 1);
    next.setHours(base.getHours(), base.getMinutes(), 0, 0);
    return next;
  }

  next.setDate(next.getDate() + 7);
  next.setHours(base.getHours(), base.getMinutes(), 0, 0);
  return next;
}

export function isDue(runAt: Date) {
  return runAt.getTime() <= Date.now();
}
