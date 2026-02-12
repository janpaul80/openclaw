import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Create log directory if it doesn't exist
const LOG_DIR = process.env.LOG_DIR || '/var/log/openclaw';
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o755 });
  } catch (error) {
    console.warn(`Could not create log directory ${LOG_DIR}: ${error.message}`);
  }
}

// Determine log destination
const logDestination = fs.existsSync(LOG_DIR) 
  ? pino.destination({ dest: path.join(LOG_DIR, 'openclaw.log'), sync: false })
  : pino.destination(1); // stdout fallback

// Create base logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
    bindings: (bindings) => {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
      };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'openclaw',
    version: process.env.VERSION || '4.0.0',
    environment: process.env.NODE_ENV || 'production',
  },
  serializers: {
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
}, logDestination);

// Log startup info
logger.info({
  type: 'startup',
  logDir: LOG_DIR,
  logLevel: process.env.LOG_LEVEL || 'info',
}, 'Logger initialized');

/**
 * Create a child logger with correlation ID
 * @param {string} correlationId - Unique request/session identifier
 * @param {object} context - Additional context (sessionId, containerId, etc.)
 * @returns {object} Child logger instance
 */
export function createLogger(correlationId, context = {}) {
  return logger.child({
    correlationId,
    ...context,
  });
}

/**
 * Create a session logger
 * @param {string} sessionId - Session identifier
 * @returns {object} Session logger instance
 */
export function createSessionLogger(sessionId) {
  return logger.child({
    sessionId,
    type: 'session',
  });
}

/**
 * Create a container logger
 * @param {string} containerId - Container identifier
 * @param {string} sessionId - Associated session ID
 * @returns {object} Container logger instance
 */
export function createContainerLogger(containerId, sessionId) {
  return logger.child({
    containerId,
    sessionId,
    type: 'container',
  });
}

/**
 * Create an execution logger
 * @param {string} sessionId - Session identifier
 * @param {string} phase - Execution phase
 * @returns {object} Execution logger instance
 */
export function createExecutionLogger(sessionId, phase) {
  return logger.child({
    sessionId,
    phase,
    type: 'execution',
  });
}

/**
 * Log execution event with standard format
 * @param {object} logger - Logger instance
 * @param {string} event - Event name
 * @param {object} data - Event data
 */
export function logExecutionEvent(logger, event, data = {}) {
  logger.info({
    event,
    timestamp: new Date().toISOString(),
    ...data,
  }, `Execution event: ${event}`);
}

/**
 * Log error with context
 * @param {object} logger - Logger instance
 * @param {Error} error - Error object
 * @param {object} context - Additional context
 */
export function logError(logger, error, context = {}) {
  logger.error({
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
    },
    ...context,
  }, `Error: ${error.message}`);
}

/**
 * Log performance metric
 * @param {object} logger - Logger instance
 * @param {string} operation - Operation name
 * @param {number} duration - Duration in milliseconds
 * @param {object} metadata - Additional metadata
 */
export function logPerformance(logger, operation, duration, metadata = {}) {
  logger.info({
    type: 'performance',
    operation,
    duration_ms: duration,
    duration_s: (duration / 1000).toFixed(2),
    ...metadata,
  }, `Performance: ${operation} took ${duration}ms`);
}

export default logger;
