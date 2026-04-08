import { PagePersona } from "@/models/PagePersona";
import { User } from "@/models/User";

type LocaleShape = {
  timezone?: string | null;
  locale?: string | null;
};

export async function resolveUserLocale(userId: string) {
  const user = (await User.findById(userId).lean()) as LocaleShape | null;
  return {
    timezone: user?.timezone ?? "Asia/Bangkok",
    locale: user?.locale ?? "th-TH"
  };
}

export async function resolvePageLocale(userId: string, pageId: string) {
  const persona = (await PagePersona.findOne({ userId, pageId, active: true }).lean()) as LocaleShape | null;
  if (persona) {
    return {
      timezone: persona.timezone ?? "Asia/Bangkok",
      locale: persona.locale ?? "th-TH"
    };
  }

  return resolveUserLocale(userId);
}

export function convertUtcToTimezone(date: Date | string, timeZone: string, locale = "en-US") {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(date));
}
