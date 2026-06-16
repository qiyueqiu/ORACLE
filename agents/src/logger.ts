/**
 * ORACLE 统一错误处理 + 日志（M2 N7）
 *
 * 原则：
 *   - 不静默吞错
 *   - 结构化日志（带 level、component、event、requestId）
 *   - 错误分级：warn / error / fatal
 *
 * 使用：
 *   import { child, ApiError } from './logger.js';
 *   const log = child({ component: 'router-agent' });
 *   log.info('parseIntent', { task: task.slice(0, 50) });
 *   log.error('router failed', { error: err.message, requestId });
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const ACTIVE_LEVEL = (process.env.LOG_LEVEL as Level) || 'info';

function ts(): string {
  return new Date().toISOString();
}

type LogData = Record<string, unknown>;

function emit(level: Level, component: string | undefined, event: string, data: LogData): void {
  if (LEVELS[level] < LEVELS[ACTIVE_LEVEL]) return;
  const out = {
    ts: ts(),
    level,
    component: component || 'oracle',
    event,
    ...data,
  };
  const line = JSON.stringify(out);
  if (level === 'error' || level === 'fatal') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export interface Logger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
  fatal(event: string, data?: LogData): void;
}

export function child(ctx: { component?: string } = {}): Logger {
  const component = ctx.component;
  return {
    debug: (event, data = {}) => emit('debug', component, event, data),
    info: (event, data = {}) => emit('info', component, event, data),
    warn: (event, data = {}) => emit('warn', component, event, data),
    error: (event, data = {}) => emit('error', component, event, data),
    fatal: (event, data = {}) => emit('fatal', component, event, data),
  };
}

export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
