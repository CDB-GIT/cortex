import pino from 'pino';
import pretty from 'pino-pretty';
import { Writable } from 'node:stream';

type BufferedLogEntry = { level: string; time: number; module?: string; msg: string };

const LOG_BUFFER_SIZE = 500;
const logBuffer: BufferedLogEntry[] = [];

const bufferStream = new Writable({
  write(chunk, _enc, cb) {
    try {
      const line = chunk.toString().trim();
      if (line.startsWith('{')) {
        const parsed = JSON.parse(line);
        logBuffer.push({
          level: pino.levels.labels[parsed.level] || 'info',
          time: parsed.time || Date.now(),
          module: parsed.module,
          msg: parsed.msg || '',
        });
        if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
      }
    } catch {
      // best effort
    }
    cb();
  },
});

const usePretty = process.env.NODE_ENV !== 'production';
const outputStream = usePretty
  ? pretty({ colorize: true, sync: true })
  : process.stdout;

const streams = usePretty
  ? [{ stream: outputStream }, { stream: bufferStream }]
  : [{ stream: process.stdout }, { stream: bufferStream }];

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream(streams as Array<{ stream: NodeJS.WritableStream }>),
);

export function createLogger(name: string) {
  return logger.child({ module: name });
}

export function setLogLevel(level: string) {
  logger.level = level;
}

export function getLogLevel(): string {
  return logger.level;
}

export function getLogBuffer(limit = 100, level?: string): typeof logBuffer {
  let logs = logBuffer.slice(-Math.min(limit, LOG_BUFFER_SIZE));
  if (level) {
    logs = logs.filter((l) => l.level === level);
  }
  return logs.reverse();
}
