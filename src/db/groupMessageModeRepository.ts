import type { Queryable } from "./queryable.js";

export type PersistedGroupMessageMode = "all" | "at_only";

export interface GroupMessageModeRecord {
  groupId: string;
  mode: PersistedGroupMessageMode;
}

export interface GroupMessageModeRepository {
  save(record: GroupMessageModeRecord): Promise<void>;
  findAll(): Promise<GroupMessageModeRecord[]>;
}

interface GroupMessageModeRow {
  group_id: string;
  mode: string;
}

const UPSERT_SQL = `
INSERT INTO group_message_modes (group_id, mode, updated_at)
VALUES ($1, $2, NOW())
ON CONFLICT (group_id) DO UPDATE
SET mode = EXCLUDED.mode,
    updated_at = NOW()
`.trim();

const SELECT_ALL_SQL = `
SELECT group_id, mode
FROM group_message_modes
ORDER BY group_id ASC
`.trim();

export class SqlGroupMessageModeRepository
  implements GroupMessageModeRepository
{
  public constructor(private readonly db: Queryable) {}

  public async save(record: GroupMessageModeRecord): Promise<void> {
    await this.db.query(UPSERT_SQL, [record.groupId, record.mode]);
  }

  public async findAll(): Promise<GroupMessageModeRecord[]> {
    const result = await this.db.query<GroupMessageModeRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => ({
      groupId: row.group_id,
      mode: parseMode(row.mode),
    }));
  }
}

function parseMode(value: string): PersistedGroupMessageMode {
  if (value === "all" || value === "at_only") {
    return value;
  }
  throw new Error(`unknown group message mode: ${value}`);
}
