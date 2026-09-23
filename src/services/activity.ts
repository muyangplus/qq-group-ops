import { randomUUID } from "node:crypto";

import { ActivityStatus } from "../core/enums.js";
import { utcNow } from "../core/models.js";
import type { ActivityRepository } from "../db/activityRepository.js";
import { WriteQueue } from "../db/writeQueue.js";

export interface Activity {
  activityId: string;
  groupId: string;
  title: string;
  createdBy: string;
  description: string;
  capacity?: number;
  status: ActivityStatus;
  createdAt: Date;
}

export interface ActivityRegistration {
  registrationId: string;
  activityId: string;
  groupId: string;
  userId: string;
  displayName: string;
  note: string;
  createdAt: Date;
}

export interface CreateActivityInput {
  groupId: string;
  title: string;
  createdBy: string;
  description?: string;
  capacity?: number;
  activityId?: string;
}

export interface RegisterActivityInput {
  activityId: string;
  userId: string;
  displayName?: string;
  note?: string;
  registrationId?: string;
}

export class ActivityService {
  private readonly activities = new Map<string, Activity>();
  private readonly registrations = new Map<string, ActivityRegistration>();
  private readonly repository: ActivityRepository | undefined;
  private readonly queue: WriteQueue | undefined;

  public constructor(repository?: ActivityRepository, queue?: WriteQueue) {
    this.repository = repository;
    this.queue = repository ? (queue ?? new WriteQueue()) : undefined;
  }

  public get persistent(): boolean {
    return this.repository !== undefined;
  }

  public async load(): Promise<void> {
    if (!this.repository) {
      return;
    }
    const [activities, registrations] = await Promise.all([
      this.repository.findActivities(),
      this.repository.findRegistrations(),
    ]);
    this.activities.clear();
    this.registrations.clear();
    for (const activity of activities) {
      this.activities.set(activity.activityId, activity);
    }
    for (const registration of registrations) {
      this.registrations.set(registration.registrationId, registration);
    }
  }

  public async flush(): Promise<void> {
    await this.queue?.flush();
  }

  public createActivity(input: CreateActivityInput): Activity {
    if (input.title.trim().length === 0) {
      throw new Error("activity title must not be empty");
    }
    if (input.capacity !== undefined && input.capacity <= 0) {
      throw new Error("activity capacity must be positive");
    }
    const activityId = input.activityId ?? randomUUID();
    if (this.activities.has(activityId)) {
      throw new Error(`duplicate activity id: ${activityId}`);
    }
    const activity: Activity = {
      activityId,
      groupId: input.groupId,
      title: input.title.trim(),
      createdBy: input.createdBy,
      description: input.description ?? "",
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      status: ActivityStatus.Draft,
      createdAt: utcNow(),
    };
    this.activities.set(activityId, activity);
    this.persistActivity(activity);
    return { ...activity };
  }

  public getActivity(activityId: string): Activity {
    const activity = this.activities.get(activityId);
    if (!activity) {
      throw new Error(`activity not found: ${activityId}`);
    }
    return { ...activity };
  }

  public listActivities(groupId: string): Activity[] {
    return [...this.activities.values()]
      .filter((activity) => activity.groupId === groupId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((activity) => ({ ...activity }));
  }

  public openActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Open);
  }

  public closeActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Closed);
  }

  public cancelActivity(activityId: string): Activity {
    return this.setStatus(activityId, ActivityStatus.Cancelled);
  }

  public register(input: RegisterActivityInput): ActivityRegistration {
    const activity = this.getActivity(input.activityId);
    if (activity.status !== ActivityStatus.Open) {
      throw new Error(`activity is not open: ${input.activityId}`);
    }
    const current = this.listRegistrations(input.activityId);
    if (activity.capacity !== undefined && current.length >= activity.capacity) {
      throw new Error(`activity is full: ${input.activityId}`);
    }
    if (current.some((registration) => registration.userId === input.userId)) {
      throw new Error(`duplicate registration: ${input.activityId}/${input.userId}`);
    }
    const registrationId = input.registrationId ?? randomUUID();
    if (this.registrations.has(registrationId)) {
      throw new Error(`duplicate registration id: ${registrationId}`);
    }
    const registration: ActivityRegistration = {
      registrationId,
      activityId: input.activityId,
      groupId: activity.groupId,
      userId: input.userId,
      displayName: input.displayName ?? "",
      note: input.note ?? "",
      createdAt: utcNow(),
    };
    this.registrations.set(registrationId, registration);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.registration.save", () =>
        repository.saveRegistration(registration),
      );
    }
    return { ...registration };
  }

  public listRegistrations(activityId: string): ActivityRegistration[] {
    return [...this.registrations.values()]
      .filter((registration) => registration.activityId === activityId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((registration) => ({ ...registration }));
  }

  public cancelRegistration(
    registrationId: string,
    userId: string,
  ): ActivityRegistration {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      throw new Error(`registration not found: ${registrationId}`);
    }
    if (registration.userId !== userId) {
      throw new Error("cannot cancel another user's registration");
    }
    this.registrations.delete(registrationId);
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.registration.delete", () =>
        repository.deleteRegistration(registrationId),
      );
    }
    return { ...registration };
  }

  private setStatus(activityId: string, status: ActivityStatus): Activity {
    const activity = this.getActivity(activityId);
    const updated: Activity = { ...activity, status };
    this.activities.set(activityId, updated);
    this.persistActivity(updated);
    return { ...updated };
  }

  private persistActivity(activity: Activity): void {
    const repository = this.repository;
    if (repository) {
      this.queue?.enqueue("activity.save", () => repository.saveActivity(activity));
    }
  }
}
