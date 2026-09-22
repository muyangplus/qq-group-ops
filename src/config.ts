export interface Settings {
  qqBotAppId: string;
  qqBotClientSecret: string;
  qqBotToken: string;
  qqBotSandbox: boolean;
  databaseUrl: string;
  adminQqIds: readonly string[];
  logLevel: string;
  logFile: string;
  logConsole: boolean;
  rawMessageRetentionDays: number;
  auditLogRetentionDays: number;
}

function asBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function asInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid integer value: ${value}`);
  }
  return parsed;
}

function splitCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    qqBotAppId: env.QQ_BOT_APP_ID ?? "",
    qqBotClientSecret: env.QQ_BOT_CLIENT_SECRET ?? "",
    qqBotToken: env.QQ_BOT_TOKEN ?? "",
    qqBotSandbox: asBool(env.QQ_BOT_SANDBOX),
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://qqbot:change-me@localhost:5432/qq_group_ops",
    adminQqIds: splitCsv(env.ADMIN_QQ_IDS),
    logLevel: (env.LOG_LEVEL ?? "info").toUpperCase(),
    logFile: env.LOG_FILE ?? "logs/qq-group-ops.log",
    logConsole: asBool(env.LOG_CONSOLE, true),
    rawMessageRetentionDays: asInt(env.RAW_MESSAGE_RETENTION_DAYS, 0),
    auditLogRetentionDays: asInt(env.AUDIT_LOG_RETENTION_DAYS, 180),
  };
}

export function hasQqCredentials(settings: Settings): boolean {
  return Boolean(settings.qqBotAppId && settings.qqBotClientSecret);
}
