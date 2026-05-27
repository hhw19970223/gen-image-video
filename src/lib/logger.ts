import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogMeta {
  [key: string]: unknown;
}

const LOG_PATH = path.join(DATA_DIR, 'app.log');
const MAX_STRING = 4000;

export function logInfo(scope: string, event: string, meta?: LogMeta): void {
  writeLog('info', scope, event, meta);
}

export function logWarn(scope: string, event: string, meta?: LogMeta): void {
  writeLog('warn', scope, event, meta);
}

export function logError(scope: string, event: string, error: unknown, meta?: LogMeta): void {
  writeLog('error', scope, event, {
    ...meta,
    error: errorToMeta(error)
  });
}

export function stepTimer(scope: string, event: string, meta?: LogMeta): {
  done: (doneMeta?: LogMeta) => void;
  fail: (error: unknown, failMeta?: LogMeta) => void;
} {
  const startedAt = Date.now();
  logInfo(scope, `${event}.start`, meta);
  return {
    done: (doneMeta?: LogMeta) => {
      logInfo(scope, `${event}.done`, {
        ...doneMeta,
        elapsedMs: Date.now() - startedAt
      });
    },
    fail: (error: unknown, failMeta?: LogMeta) => {
      logError(scope, `${event}.failed`, error, {
        ...failMeta,
        elapsedMs: Date.now() - startedAt
      });
    }
  };
}

function writeLog(level: LogLevel, scope: string, event: string, meta?: LogMeta): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    scope,
    event,
    ...(meta ? sanitize(meta) as Record<string, unknown> : {})
  };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never break user tasks.
  }

  const line = `[${entry.time}] [${level}] [${scope}] ${event}`;
  if (level === 'error') console.error(line, meta ?? '');
  else if (level === 'warn') console.warn(line, meta ?? '');
  else if (process.env.LOG_CONSOLE === 'true') console.log(line, meta ?? '');
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[max-depth]';
  if (value instanceof Error) return errorToMeta(value);
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length}]` : value;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 30) {
      return [
        ...value.slice(0, 30).map(item => sanitize(item, depth + 1)),
        `[truncated array length=${value.length}]`
      ];
    }
    return value.map(item => sanitize(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitize(item, depth + 1);
    }
  }
  return out;
}

function errorToMeta(error: unknown): LogMeta {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}
