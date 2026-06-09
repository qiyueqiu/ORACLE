/**
 * ORACLE 统一错误处理 + 日志（M2 N7）
 *
 * 原则：
 *   - 不静默吞错
 *   - 结构化日志（带 level、component、event、requestId）
 *   - 错误分级：warn / error / fatal
 *
 * 使用：
 *   const logger = require('./logger');
 *   const log = logger.child({ component: 'router-agent' });
 *   log.info('parseIntent', { task: task.slice(0, 50) });
 *   log.error('router failed', { error: err.message, requestId });
 */
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const ACTIVE_LEVEL = process.env.LOG_LEVEL || 'info';

function ts() { return new Date().toISOString(); }

function emit(level, component, event, data) {
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

function child(ctx = {}) {
    const component = ctx.component;
    return {
        debug: (event, data = {}) => emit('debug', component, event, data),
        info: (event, data = {}) => emit('info', component, event, data),
        warn: (event, data = {}) => emit('warn', component, event, data),
        error: (event, data = {}) => emit('error', component, event, data),
        fatal: (event, data = {}) => emit('fatal', component, event, data),
    };
}

class ApiError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
    }
}

module.exports = { child, ApiError };
