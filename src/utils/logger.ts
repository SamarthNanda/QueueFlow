/**
 * Winston Logger Configuration
 * Provides structured logging with different levels and formats
 */

import winston from 'winston';
import { LogContext, LogLevel } from '../types';

// Define custom log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Custom format for console output (more readable in development)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      metaStr = '\n' + JSON.stringify(meta, null, 2);
    }
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Create logger instance
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.LOG_FORMAT === 'json' ? logFormat : consoleFormat,
  defaultMeta: { service: 'queueflow' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production' ? logFormat : consoleFormat
    }),
    // File transport for errors
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // File transport for all logs
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' })
  ]
});

/**
 * Logger utility class with contextual logging
 */
export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Create a child logger with additional context
   */
  public child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }

  /**
   * Log error message
   */
  public error(message: string, meta?: any): void {
    logger.error(message, { ...this.context, ...meta });
  }

  /**
   * Log warning message
   */
  public warn(message: string, meta?: any): void {
    logger.warn(message, { ...this.context, ...meta });
  }

  /**
   * Log info message
   */
  public info(message: string, meta?: any): void {
    logger.info(message, { ...this.context, ...meta });
  }

  /**
   * Log debug message
   */
  public debug(message: string, meta?: any): void {
    logger.debug(message, { ...this.context, ...meta });
  }

  /**
   * Log with specific level
   */
  public log(level: LogLevel, message: string, meta?: any): void {
    logger.log(level, message, { ...this.context, ...meta });
  }

  /**
   * Time an operation and log the duration
   */
  public async time<T>(
    operation: string,
    fn: () => Promise<T>,
    level: LogLevel = LogLevel.INFO
  ): Promise<T> {
    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;
      this.log(level, `${operation} completed`, { duration });
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.error(`${operation} failed`, { duration, error });
      throw error;
    }
  }

  /**
   * Create a logger for a specific component
   */
  public static forComponent(component: string): Logger {
    return new Logger({ component });
  }

  /**
   * Create a logger for a specific job
   */
  public static forJob(jobId: string, type?: string): Logger {
    return new Logger({ jobId, jobType: type });
  }

  /**
   * Create a logger for a specific worker
   */
  public static forWorker(workerId: string): Logger {
    return new Logger({ workerId });
  }
}

/**
 * Performance monitoring decorator
 */
export function LogPerformance(operation?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const opName = operation || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      const startTime = Date.now();
      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;
        logger.debug(`${opName} completed`, { duration });
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`${opName} failed`, { duration, error });
        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Error logging decorator
 */
export function LogErrors(rethrow: boolean = true) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const methodName = `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      try {
        return await originalMethod.apply(this, args);
      } catch (error) {
        logger.error(`Error in ${methodName}`, {
          error,
          args: args.length > 0 ? args : undefined
        });
        if (rethrow) {
          throw error;
        }
      }
    };

    return descriptor;
  };
}

// Export the default logger instance
export default logger;
