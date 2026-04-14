import { PostingSettings } from "@/models/PostingSettings";
import { User } from "@/models/User";

export type SettingsDocShape = {
  pageLimitOverride?: number | null;
  hourlyPostLimit?: number | null;
  dailyPostLimit?: number | null;
  commentHourlyLimit?: number | null;
  minDelaySeconds?: number | null;
  maxDelaySeconds?: number | null;
  duplicateWindowHours?: number | null;
  autoPostDuplicateWindowHours?: number | null;
  apiBurstWindowMs?: number | null;
  apiBurstMax?: number | null;
  tokenExpiryWarningHours?: number | null;
};

export type UserDocShape = {
  pageLimit?: number | null;
  plan?: string | null;
};

export async function getUserSettings(userId: string): Promise<{
  settings: SettingsDocShape | null;
  user: UserDocShape | null;
}> {
  const settings = (await PostingSettings.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true }
  ).lean()) as SettingsDocShape | null;

  const user = (await User.findById(userId).lean()) as UserDocShape | null;
  return {
    settings,
    user
  };
}

export function getEffectivePageLimit(user: { pageLimit?: number | null; plan?: string | null }, settings: { pageLimitOverride?: number | null }) {
  return settings.pageLimitOverride ?? user.pageLimit ?? (user.plan === "pro" ? 20 : user.plan === "business" ? 100 : 5);
}

export function randomDelayMs(minSeconds: number, maxSeconds: number) {
  const min = Math.max(0, minSeconds) * 1000;
  const max = Math.max(min, maxSeconds * 1000);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
