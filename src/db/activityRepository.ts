import type { ActivityStatus } from "../core/enums.js";
import type {
  Activity,
  ActivityRegistration,
} from "../services/activity.js";
import type { Queryable } from "./queryable.js";

export interface ActivityRepository {
  saveActivity(activity: Activity): Promise<void>;
  findActivities(): Promise<Activity[]>;
  saveRegistration(registration: ActivityRegistration): Promise<void>;
  deleteRegistration(registrationId: string): Promise<void>;
  findRegistrations(): Promise<ActivityRegistration[]>;
}

interface ActivityRow {
  activity_id: string;
  group_id: string;
  title: string;
  created_by: string;
  description: string;
  capacity: number | null;
  status: string;
  created_at: string | Date;
}

interface ActivityRegistrationRow {
  registration_id: string;
  activity_id: string;
  group_id: string;
  user_id: string;
  display_name: string;
  note: string;
  created_at: string | Date;
}

const UPSERT_ACTIVITY_SQL = `
INSERT INTO activities (
  activity_id, group_id, title, created_by, description, capacity, status, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (activity_id) DO UPDATE SET
  group_id = EXCLUDED.group_id,
  title = EXCLUDED.title,
  created_by = EXCLUDED.created_by,
  description = EXCLUDED.description,
  capacity = EXCLUDED.capacity,
  status = EXCLUDED.status
`.trim();

const SELECT_ACTIVITIES_SQL = `
SELECT activity_id, group_id, title, created_by, description, capacity, status, created_at
FROM activities
ORDER BY created_at ASC
`.trim();

const UPSERT_REGISTRATION_SQL = `
INSERT INTO activity_registrations (
  registration_id, activity_id, group_id, user_id, display_name, note, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (registration_id) DO NOTHING
`.trim();

const DELETE_REGISTRATION_SQL = `
DELETE FROM activity_registrations
WHERE registration_id = $1
`.trim();

const SELECT_REGISTRATIONS_SQL = `
SELECT registration_id, activity_id, group_id, user_id, display_name, note, created_at
FROM activity_registrations
ORDER BY created_at ASC
`.trim();

export class SqlActivityRepository implements ActivityRepository {
  public constructor(private readonly db: Queryable) {}

  public async saveActivity(activity: Activity): Promise<void> {
    await this.db.query(UPSERT_ACTIVITY_SQL, [
      activity.activityId,
      activity.groupId,
      activity.title,
      activity.createdBy,
      activity.description,
      activity.capacity ?? null,
      activity.status,
      activity.createdAt.toISOString(),
    ]);
  }

  public async findActivities(): Promise<Activity[]> {
    const result = await this.db.query<ActivityRow>(SELECT_ACTIVITIES_SQL);
    return result.rows.map((row) => ({
      activityId: row.activity_id,
      // 扩展字段（短码/链接/报名限制）由 activity_details 表合并进来
      code: "",
      groupId: row.group_id,
      groupNumber: "",
      title: row.title,
      createdBy: row.created_by,
      description: row.description,
      links: [],
      ...(row.capacity !== null ? { capacity: row.capacity } : {}),
      allowColleges: [],
      denyColleges: [],
      allowYears: [],
      denyYears: [],
      // @全体 / 通知发起人 / 截止时间由 activity_settings 表合并进来
      mentionAll: false,
      notifyCreator: false,
      waitlistPromotion: "manual",
      status: row.status as ActivityStatus,
      createdAt: toDate(row.created_at),
    }));
  }

  public async saveRegistration(
    registration: ActivityRegistration,
  ): Promise<void> {
    await this.db.query(UPSERT_REGISTRATION_SQL, [
      registration.registrationId,
      registration.activityId,
      registration.groupId,
      registration.userId,
      registration.displayName,
      registration.note,
      registration.createdAt.toISOString(),
    ]);
  }

  public async deleteRegistration(registrationId: string): Promise<void> {
    await this.db.query(DELETE_REGISTRATION_SQL, [registrationId]);
  }

  public async findRegistrations(): Promise<ActivityRegistration[]> {
    const result = await this.db.query<ActivityRegistrationRow>(
      SELECT_REGISTRATIONS_SQL,
    );
    return result.rows.map((row) => ({
      registrationId: row.registration_id,
      activityId: row.activity_id,
      groupId: row.group_id,
      userId: row.user_id,
      displayName: row.display_name,
      note: row.note,
      createdAt: toDate(row.created_at),
    }));
  }
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
