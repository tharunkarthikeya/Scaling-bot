import pino from 'pino';
import { config } from './config.js';

const isDev = config.NODE_ENV === 'development';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Candidate documents are PII. Never let a token or a raw payload reach the log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'accessToken',
      'apiKey',
      '*.access_token',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
