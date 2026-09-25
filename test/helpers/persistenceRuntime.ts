import { loadSettings } from "../../src/config.js";
import { SqlActivityRepository } from "../../src/db/activityRepository.js";
import { SqlActivityDetailsRepository } from "../../src/db/activityDetailsRepository.js";
import { SqlActivitySettingsRepository } from "../../src/db/activitySettingsRepository.js";
import { SqlActivityWaitlistRepository } from "../../src/db/activityWaitlistRepository.js";
import { SqlAuditRepository } from "../../src/db/auditRepository.js";
import { SqlGroupConfigRepository } from "../../src/db/groupConfigRepository.js";
import { SqlGroupSettingsRepository } from "../../src/db/groupSettingsRepository.js";
import { SqlGroupMessageModeRepository } from "../../src/db/groupMessageModeRepository.js";
import { SqlIdentityBindingRepository } from "../../src/db/identityBindingRepository.js";
import { SqlJoinRequestRepository } from "../../src/db/joinRequestRepository.js";
import {
  SqlNotificationDeliveryRepository,
  SqlNotificationSubscriptionRepository,
} from "../../src/db/notificationRepository.js";
import { SqlPermissionRepository } from "../../src/db/permissionRepository.js";
import { SqlShortCodeRepository } from "../../src/db/shortCodeRepository.js";
import { SqlClassAliasRepository } from "../../src/db/classAliasRepository.js";
import { SqlUserProfileRepository } from "../../src/db/userProfileRepository.js";
import type { Queryable } from "../../src/db/queryable.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";

/** 用真实仓储装配 runtime，生产装配路径的最小测试替身。 */
export function createPersistentRuntime(
  queryable: Queryable,
  adminUserIds = "root",
): Runtime {
  return createRuntime(loadSettings({ ADMIN_USER_IDS: adminUserIds }), {
    repositories: {
      audit: new SqlAuditRepository(queryable),
      joinRequests: new SqlJoinRequestRepository(queryable),
      groupConfigs: new SqlGroupConfigRepository(queryable),
      groupSettings: new SqlGroupSettingsRepository(queryable),
      identityBindings: new SqlIdentityBindingRepository(queryable),
      groupMessageModes: new SqlGroupMessageModeRepository(queryable),
      permissions: new SqlPermissionRepository(queryable),
      activities: new SqlActivityRepository(queryable),
      activityDetails: new SqlActivityDetailsRepository(queryable),
      activityWaitlist: new SqlActivityWaitlistRepository(queryable),
      activitySettings: new SqlActivitySettingsRepository(queryable),
      notificationSubscriptions:
        new SqlNotificationSubscriptionRepository(queryable),
      notificationDeliveries:
        new SqlNotificationDeliveryRepository(queryable),
      shortCodes: new SqlShortCodeRepository(queryable),
      userProfiles: new SqlUserProfileRepository(queryable),
      classAliases: new SqlClassAliasRepository(queryable),
    },
  });
}
