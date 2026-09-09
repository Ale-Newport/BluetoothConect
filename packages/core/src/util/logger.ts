/**
 * Local-only structured logger. AirLink never sends telemetry anywhere; this
 * writes to an in-memory ring buffer that Developer Mode renders, and
 * optionally to the console in development.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly at: number;
  readonly level: LogLevel;
  readonly scope: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class LogBuffer {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly capacity = 1000) {}

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  snapshot(): readonly LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  buffer?: LogBuffer;
  console?: boolean;
  now?: () => number;
}

export class Logger {
  readonly buffer: LogBuffer;
  private minLevel: LogLevel;
  private readonly toConsole: boolean;
  private readonly now: () => number;

  constructor(
    private readonly scope: string,
    options: LoggerOptions = {},
  ) {
    this.buffer = options.buffer ?? new LogBuffer();
    this.minLevel = options.minLevel ?? 'info';
    this.toConsole = options.console ?? false;
    this.now = options.now ?? (() => Date.now());
  }

  child(scope: string): Logger {
    const child = new Logger(`${this.scope}:${scope}`, {
      minLevel: this.minLevel,
      buffer: this.buffer,
      console: this.toConsole,
      now: this.now,
    });
    return child;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = data
      ? { at: this.now(), level, scope: this.scope, message, data }
      : { at: this.now(), level, scope: this.scope, message };
    this.buffer.push(entry);
    if (this.toConsole) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[${this.scope}] ${message}`, data ?? '');
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }
  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }
  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }
  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }
}

export const silentLogger = new Logger('silent', { minLevel: 'error' });
