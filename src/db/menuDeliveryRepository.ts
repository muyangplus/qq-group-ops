import type { Queryable } from "./queryable.js";

/**
 * 「私信首次交互推一次主菜单」的去重记录。
 *
 * 只存 user_id 与推送时间，不存任何聊天内容；用户量级下很小，且不需要按保留策略清理
 * （删除记录会导致重启后重复推送）。
 */
export interface MenuDeliveryRepository {
  /** 已推送过的用户 id 列表。 */
  findAll(): Promise<string[]>;
  markPushed(userId: string, pushedAt: string): Promise<void>;
}

interface MenuDeliveryRow {
  user_id: string;
}

const UPSERT_SQL = `
INSERT INTO menu_deliveries (user_id, pushed_at)
VALUES ($1, $2)
ON CONFLICT (user_id) DO UPDATE
SET pushed_at = EXCLUDED.pushed_at
`.trim();

const SELECT_ALL_SQL = `
SELECT user_id
FROM menu_deliveries
ORDER BY user_id ASC
`.trim();

export class SqlMenuDeliveryRepository implements MenuDeliveryRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAll(): Promise<string[]> {
    const result = await this.db.query<MenuDeliveryRow>(SELECT_ALL_SQL);
    return result.rows.map((row) => row.user_id);
  }

  public async markPushed(userId: string, pushedAt: string): Promise<void> {
    await this.db.query(UPSERT_SQL, [userId, pushedAt]);
  }
}
