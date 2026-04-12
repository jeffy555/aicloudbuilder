/**
 * Lightweight structured logger.
 * Wraps console methods with JSON-structured output in production,
 * and readable colored output in development.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) || 'info'] ?? 1;
const IS_PROD = process.env.NODE_ENV === 'production';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  [key: string]: unknown;
}

function formatLog(entry: LogEntry): string {
  if (IS_PROD) {
    // JSON structured logs for production (parseable by log aggregators)
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    });
  }
  // Human-readable for development
  const { level, module, message, ...extra } = entry;
  const prefix = `[${module}]`;
  const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
  return `${prefix} ${message}${extraStr}`;
}

export function createLogger(module: string) {
  return {
    debug(message: string, extra?: Record<string, unknown>) {
      if (LOG_LEVELS.debug >= MIN_LEVEL) {
        console.debug(formatLog({ level: 'debug', module, message, ...extra }));
      }
    },
    info(message: string, extra?: Record<string, unknown>) {
      if (LOG_LEVELS.info >= MIN_LEVEL) {
        console.log(formatLog({ level: 'info', module, message, ...extra }));
      }
    },
    warn(message: string, extra?: Record<string, unknown>) {
      if (LOG_LEVELS.warn >= MIN_LEVEL) {
        console.warn(formatLog({ level: 'warn', module, message, ...extra }));
      }
    },
    error(message: string, extra?: Record<string, unknown>) {
      if (LOG_LEVELS.error >= MIN_LEVEL) {
        console.error(formatLog({ level: 'error', module, message, ...extra }));
      }
    },
  };
}
