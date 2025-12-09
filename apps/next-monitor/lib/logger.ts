type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatLog(entry: LogEntry): string {
  const prefix = entry.context ? `[${entry.context}]` : '';
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  return `${entry.timestamp} ${entry.level.toUpperCase()} ${prefix} ${entry.message}${dataStr}`;
}

function log(level: LogLevel, context: string, message: string, data?: Record<string, unknown>) {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    level,
    message,
    context,
    timestamp: new Date().toISOString(),
    data,
  };

  const formatted = formatLog(entry);

  switch (level) {
    case 'debug':
      console.debug(formatted);
      break;
    case 'info':
      console.info(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'error':
      console.error(formatted);
      break;
  }
}

export const logger = {
  debug: (ctx: string, msg: string, data?: Record<string, unknown>) => log('debug', ctx, msg, data),
  info: (ctx: string, msg: string, data?: Record<string, unknown>) => log('info', ctx, msg, data),
  warn: (ctx: string, msg: string, data?: Record<string, unknown>) => log('warn', ctx, msg, data),
  error: (ctx: string, msg: string, data?: Record<string, unknown>) => log('error', ctx, msg, data),
};

export default logger;
