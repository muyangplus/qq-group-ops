import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { formatLogTime } from "./timeFormat.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogColorMode = "auto" | "always" | "never";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  cyan: "\u001b[36m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
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
  public constructor(private readonly colorEnabled = false) {}

  public write(entry: LogEntry): void {
    const line = formatEntry(entry, this.colorEnabled);
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
      time: formatLogTime(new Date()),
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

export interface ColorResolutionOptions {
  mode: LogColorMode;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  supportsColor?: boolean;
}

export function resolveColorEnabled(options: ColorResolutionOptions): boolean {
  const env = options.env ?? process.env;
  if (options.mode === "never") {
    return false;
  }
  if (env.NO_COLOR && options.mode !== "always") {
    return false;
  }
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") {
    return true;
  }
  if (options.mode === "always") {
    return true;
  }
  return Boolean(options.isTTY && options.supportsColor);
}

export function formatEntry(entry: LogEntry, color = false): string {
  const context = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  if (!color) {
    return `${entry.time} [${entry.level}] [${entry.module}] ${entry.message}${context}`;
  }
  return [
    `${ANSI.dim}${entry.time}${ANSI.reset}`,
    `${LEVEL_COLOR[entry.level]}[${entry.level}]${ANSI.reset}`,
    `${ANSI.dim}[${entry.module}]${ANSI.reset}`,
    `${entry.message}${context}`,
  ].join(" ");
}

let activeLogger: Logger = new StructuredLogger("info", []);
let activeTransports: LogTransport[] = [];

export function configureLogging(options: {
  level?: string;
  file?: string;
  console?: boolean;
  color?: string;
}): Logger {
  const level = parseLevel(options.level);
  const transports: LogTransport[] = [];
  if (options.console !== false) {
    transports.push(
      new ConsoleTransport(
        resolveColorEnabled({
          mode: parseColorMode(options.color),
          env: process.env,
          isTTY: Boolean(process.stdout.isTTY),
          supportsColor: detectColorSupport(),
        }),
      ),
    );
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

function parseColorMode(value: string | undefined): LogColorMode {
  const normalized = (value ?? "auto").toLowerCase();
  if (normalized === "always" || normalized === "never") {
    return normalized;
  }
  return "auto";
}

function detectColorSupport(): boolean {
  try {
    const stdout = process.stdout as unknown as {
      isTTY?: boolean;
      hasColors?: (depth?: number) => boolean;
    };
    if (!stdout.isTTY) {
      return false;
    }
    if (typeof stdout.hasColors === "function") {
      return stdout.hasColors();
    }
    return true;
  } catch {
    return false;
  }
}
