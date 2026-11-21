/**
 * Business days (Monday to Friday) in a given timezone. Public holidays are not counted: they
 * differ by country and region, and a reminder on a holiday does no harm.
 */

const WEEKDAY = new Map([["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]]);

/** Day of the week (0 = Sunday) of an instant, in `timeZone`. */
export function weekdayIn(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
  return WEEKDAY.get(name)!;
}

/** True when `at` falls on a Monday to Friday in `timeZone`. */
export function isBusinessDay(at: Date, timeZone: string): boolean {
  const d = weekdayIn(at, timeZone);
  return d >= 1 && d <= 5;
}

/**
 * The instant `days` business days after `from`, at the same time of day. Weekend days are skipped,
 * so Friday plus 3 business days is Wednesday. A start on a weekend counts from Monday.
 */
export function addBusinessDays(from: Date, days: number, timeZone: string): Date {
  const DAY = 86_400_000;
  let at = from.getTime();
  let left = days;
  while (left > 0) {
    at += DAY;
    if (isBusinessDay(new Date(at), timeZone)) left--;
  }
  return new Date(at);
}

/** "REMINDER", "2ND REMINDER", "3RD REMINDER", "4TH REMINDER", ... for the nth reminder (1-based). */
export function reminderLabel(n: number): string {
  if (n <= 1) return "REMINDER";
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" } as Record<number, string>)[n % 10] ?? "TH";
  return `${n}${suffix} REMINDER`;
}
