export type ApiResponse<T> = {
  ok: boolean;
  message?: string;
  data?: T;
};

export type ScheduleFrequency = "once" | "hourly" | "daily" | "weekly";
export type PostingMode = "broadcast" | "random-page";

export type GeneratedVariant = {
  caption: string;
  hashtags: string[];
};
