import type { AdminCommandContext } from "./context.js";
import {
  formatParseNotes,
  parseProfileInput,
} from "../profileParser.js";
import {
  CLEAR_WORDS,
  PROFILE_FIELD_ALIASES,
  PROFILE_FIELD_LABELS,
  PROFILE_USAGE,
  formatError,
  normalize,
  type CommandResult,
} from "./support.js";
import {
  UserProfileError,
  yearFromStudentId,
  type UserProfileField,
} from "../userProfiles.js";

/**
 * `/profile` 领域模块：个人资料查看 / 设置（含一条消息填完的智能识别）/ 清空。
 */
export function handleProfile(
  ctx: AdminCommandContext,userId: string, parts: readonly string[]): CommandResult {
    const profiles = ctx.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用。" };
    }
    const action = normalize(parts[1]);
    if (!action) {
      return { ok: true, text: formatProfile(ctx, userId) };
    }
    if (action === "set" || action === "设置") {
      const field = PROFILE_FIELD_ALIASES[normalize(parts[2])];
      if (!field) {
        return updateProfileSmart(ctx, userId, parts.slice(2).join(" "));
      }
      const value = parts.slice(3).join(" ").trim();
      if (value.length === 0) {
        return { ok: false, text: PROFILE_USAGE };
      }
      if (CLEAR_WORDS.has(value.toLowerCase())) {
        profiles.clear(userId, field);
        return {
          ok: true,
          text: `已清除：${PROFILE_FIELD_LABELS[field]}\n\n${formatProfile(ctx, userId)}`,
        };
      }
      try {
        profiles.set(userId, field, value);
      } catch (error) {
        return { ok: false, text: `设置失败：${formatError(error)}` };
      }
      return {
        ok: true,
        text: `已更新：${PROFILE_FIELD_LABELS[field]}\n\n${formatProfile(ctx, userId)}`,
      };
    }
    if (action === "clear" || action === "清除" || action === "重置") {
      profiles.clear(userId);
      return { ok: true, text: "已清空个人资料。" };
    }
    return { ok: false, text: PROFILE_USAGE };
  }

  /**
   * 智能 `/profile set`：一次给班级/姓名/学号，顺序与分隔符随意。
   * 有歧义或残留时整体不写入，只回报识别结果，让用户改用 `字段=值`。
   */
export function updateProfileSmart(
  ctx: AdminCommandContext,userId: string, raw: string): CommandResult {
    const profiles = ctx.userProfiles;
    if (!profiles) {
      return { ok: false, text: "个人资料服务未启用。" };
    }
    const parsed = parseProfileInput(raw, {
      roster: profiles.rosterRef,
      aliases: ctx.classAliases,
    });
    if (parsed.error) {
      return {
        ok: false,
        text: `${parsed.error}\n\n${formatParseNotes(parsed)}\n\n${PROFILE_USAGE}`,
      };
    }
    if (parsed.fields.name === undefined
      && parsed.fields.studentId === undefined
      && parsed.fields.className === undefined
      && parsed.fields.college === undefined
      && parsed.fields.year === undefined) {
      return { ok: false, text: PROFILE_USAGE };
    }
    // 先整体校验再写入，避免"写一半失败"。
    try {
      if (parsed.fields.studentId !== undefined) {
        yearFromStudentId(parsed.fields.studentId);
      }
      if (parsed.fields.className !== undefined) {
        const roster = profiles.rosterRef;
        if (!roster) {
          throw new UserProfileError("班级库未加载，请联系管理员");
        }
        if (!roster.hasClass(parsed.fields.className)) {
          throw new UserProfileError(`班级「${parsed.fields.className}」不在班级库中`);
        }
      }
      if (parsed.fields.name !== undefined) {
        const name = parsed.fields.name.replace(/\s+/gu, "");
        if (name.length === 0 || name.length > 20) {
          throw new UserProfileError("姓名需要 1-20 个字符（不含空格）");
        }
      }
    } catch (error) {
      return {
        ok: false,
        text: `设置失败：${formatError(error)}\n\n${formatParseNotes(parsed)}`,
      };
    }
    // 学号先写（确定年级），班级再写（自动带出学院/年级），显式学院/年级最后覆盖，姓名垫底。
    const order: UserProfileField[] = ["studentId", "className", "college", "year", "name"];
    const applied: string[] = [];
    for (const key of order) {
      const value = parsed.fields[key];
      if (value === undefined) {
        continue;
      }
      try {
        profiles.set(userId, key, value);
      } catch (error) {
        return { ok: false, text: `设置失败：${formatError(error)}` };
      }
      applied.push(PROFILE_FIELD_LABELS[key]);
    }
    const lines = [`已更新：${applied.join("、")}`];
    const notes = formatParseNotes(parsed);
    if (notes.length > 0) {
      lines.push(notes);
    }
    lines.push("", formatProfile(ctx, userId));
    return { ok: true, text: lines.join("\n") };
  }

export function formatProfile(
  ctx: AdminCommandContext,userId: string): string {
    const profile = ctx.userProfiles?.get(userId);
    const userLabel = ctx.helpers.displayUser(userId);
    if (!profile) {
      return [
        "尚未设置个人资料。",
        "请发送一条组合指令（学号 / 班级 / 姓名，顺序与分隔符随意）：",
        `/profile set <学号> <班级> <姓名>`,
      ].join("\n");
    }
    return [
      `姓名：${profile.name || "（未填）"}`,
      `学号：${profile.studentId || "（未填）"}${
        profile.studentId && profile.year ? `（${profile.year} 级）` : ""
      }`,
      `班级：${profile.className || "（未填）"}`,
      `学院：${profile.college || "（未填）"}`,
    ].join("\n");
  }

  // ------------------------------------------------------------ /activity

