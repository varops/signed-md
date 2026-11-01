const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: Level): void {
  threshold = LEVELS[level];
}

/** Structured JSON logs, one object per line. */
function write(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => write("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => write("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => write("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => write("error", m, d),
};
