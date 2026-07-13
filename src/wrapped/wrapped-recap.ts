export type WrappedTopItem = {
  name: string;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
};

export type WrappedMonth = {
  month: string;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
  level: 0 | 1 | 2 | 3 | 4;
};

export type WrappedDay = {
  date: string;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
};

export type WrappedRecap = {
  year: number;
  timezone: string;
  from: string;
  to: string;
  totalTokens: number;
  costUsd?: number;
  costIncomplete?: boolean;
  activeDays: number;
  longestStreak: number;
  activeMs: number;
  peakHour?: { hour: number; totalTokens: number };
  weekdayTokens: number;
  weekendTokens: number;
  busiestDay?: { date: string; totalTokens: number; costUsd?: number; costIncomplete?: boolean };
  estimatedCacheSavingsUsd?: number;
  eventCount: number;
  sessionCount: number;
  topModels: WrappedTopItem[];
  topSources: WrappedTopItem[];
  monthlyIntensity: WrappedMonth[];
  dailyIntensity: WrappedDay[];
};
