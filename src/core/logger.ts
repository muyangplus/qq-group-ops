import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  time: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface LogTransport {
  write(entry: LogEntry): void;
  close?(): Promise<void> | void;
}

export class ConsoleTransport implements LogTransport {
  public write(entry: LogEntry): void {
    const line = formatEntry(entry);
    if (entry.level === "error") {
      console.error(line);
      return;
    }
    if (entry.level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }
}

export class FileTransport implements LogTransport {
  private readonly stream: WriteStream;

  public constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: "a" });
  }

  public write(entry: LogEntry): void {
    this.stream.write(`${JSON.stringify(entry)}\n`);
  }

  public async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(module: string): Logger;
}

export class StructuredLogger implements Logger {
  public constructor(
    private readonly level: LogLevel,
    private readonly transports: readonly LogTransport[],
    private readonly module = "root",
  ) {}

  public debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  public child(module: string): Logger {
    const childModule = this.module === "root" ? module : `${this.module}:${module}`;
    return new StructuredLogger(this.level, this.transports, childModule);
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) {
      return;
    }
    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...(context ? { context } : {}),
    };
    for (const transport of this.transports) {
      transport.write(entry);
    }
  }
}

let activeLogger: Logger = new StructuredLogger("info", []);
let activeTransports: LogTransport[] = [];

export function configureLogging(options: {
  level?: string;
  file?: string;
  console?: boolean;
}): Logger {
  const level = parseLevel(options.level);
  const transports: LogTransport[] = [];
  if (options.console !== false) {
    transports.push(new ConsoleTransport());
  }
  if (options.file) {
    transports.push(new FileTransport(options.file));
  }
  activeTransports = transports;
  activeLogger = new StructuredLogger(level, transports);
  return activeLogger;
}

export function getLogger(module: string): Logger {
  return {
    debug: (message, context) => activeLogger.child(module).debug(message, context),
    info: (message, context) => activeLogger.child(module).info(message, context),
    warn: (message, context) => activeLogger.child(module).warn(message, context),
    error: (message, context) => activeLogger.child(module).error(message, context),
    child: (childModule) => getLogger(`${module}:${childModule}`),
  };
}

export async function closeLogging(): Promise<void> {
  for (const transport of activeTransports) {
    await transport.close?.();
  }
  activeTransports = [];
}

function parseLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? "info").toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

function formatEntry(entry: LogEntry): string {
  const context = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  return `${entry.time} [${entry.level}] [${entry.module}] ${entry.message}${context}`;
}
