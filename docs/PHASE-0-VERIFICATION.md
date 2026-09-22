# Phase 0：官方 API 能力验证清单

> 本清单是进入实现的闸门。所有 “公开检索已发现” 都只作为线索，最终以官方文档、开放平台后台和测试群实测为准。

## 状态说明

- ✅ 已验证：有明确官方文档或可靠来源，且语义清晰。
- 🟡 部分验证：存在接口/事件，但开通条件或权限边界不明。
- ❌ 未验证：公开检索无法确认具体数字或行为。
- ⚠️ 存在矛盾：不同来源说法冲突。

## 验证总表

| ID | 验证项 | 当前公开检索结论 | 最终判定 |
|---|---|---|---|
| V0-1 | 全量群消息接收 | 🟡 官方有“群消息（全量模式）”和“群聊消息接收开启”事件；社区代码显示需要显式 `GROUP_MESSAGE` intent | 待实测 |
| V0-2 | 撤回他人消息 | 🟡 官方有“撤回群聊消息”接口；社区官方群管插件未列撤回，OneBot 插件列了撤回 | 待实测 |
| V0-3 | 入群申请审批 | ✅ 官方有入群申请事件、审批接口和自动审批策略接口 | 待后台确认 |
| V0-4 | 好友申请 / 群邀请审批 | 🟡 官方有“用户添加好友”事件；人工同意/拒绝接口未确认；社区插件可能面向 OneBot | 待实测 |
| V0-5 | 频率限制与配额 | ❌ 公开检索未找到明确数字 | 待后台查看 |
| V0-6 | 可管理群数量 | ❌ 未确认 | 待后台确认 |
| V0-7 | 个人开发者群聊权限 | ⚠️ 社区称已开放群聊，另有文章称个人开发者无接口 | 待登录后台确认 |
| V0-8 | 内容安全 API 价格与数据条款 | 🟡 有计费入口和服务条款，具体数字需官网计算 | 待确认 |
| V0-9 | 部署与备份条件 | ✅ 方案可行 | 待环境验证 |
| V0-10 | 活动报名与信息导出能力 | 🟡 取决于官方 API 是否提供群成员/消息/申请数据 | 待实测 |

## V0-1 全量群消息接收

**验证方法**：

1. 在 QQ 开放平台后台检查事件订阅和 intent 配置。
2. 启用 `GROUP_MESSAGE` intent（以官方后台实际名称为准）。
3. 在测试群中用普通成员发送一条不带 @ 的文本消息。
4. 观察是否收到 `group_message_create` / `GROUP_MESSAGE_CREATE` 事件。
5. 分别测试：群主发言、管理员发言、普通成员发言、图片/文件消息。

**通过标准**：

- 能稳定收到未 @ 的普通群消息。
- 明确是否需要申请、群主开启或白名单。
- 明确消息类型支持范围。

**公开线索**：

- [群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)
- [群聊消息接收开启](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_msg_receive.html)
- [Hermes Agent PR #52944](https://github.com/NousResearch/hermes-agent/pull/52944)
- [Hermes Agent PR #63765](https://github.com/NousResearch/hermes-agent/pull/63765)

## V0-2 撤回他人消息

**验证方法**：

1. bot 作为普通成员，尝试撤回其他成员的消息，记录错误码。
2. 将 bot 设为群管理员，再测一次。
3. 分别测试 2 分钟内和超过 2 分钟的消息。
4. 测试文本、图片、文件等不同消息类型。

**通过标准**：

- 明确 bot 是否能撤回他人消息。
- 明确所需群内身份和时间窗口。
- 明确不支持时的替代策略：警告、禁言、留证后人工处理。

**公开线索**：

- [撤回群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages_message_id.delete.html)
- [@zhin.js/adapter-qq](https://www.npmjs.com/package/@zhin.js/adapter-qq)
- [koishi-plugin-qgroup-management](https://www.npmjs.com/package/koishi-plugin-qgroup-management)

## V0-3 入群申请审批

**验证方法**：

1. 在测试群发起入群申请。
2. 观察官方 bot 是否收到入群申请事件。
3. 调用入群申请审批接口，分别测试通过和拒绝。
4. 测试自动审批策略是否可用。

**通过标准**：

- 能读取申请列表、申请人信息和申请理由。
- 能通过或拒绝申请。
- 能记录操作人和审批结果。

**公开线索**：

- [用户申请加群](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_join_request.html)
- [入群申请审批](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_approval_join_request_member_openid.post.html)
- [创建入群自动审批策略](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_join_approval_strategy.post.html)

## V0-4 好友申请 / 群邀请审批

**验证方法**：

1. 用另一个 QQ 号添加 bot 为好友，观察 `friend_add` 事件。
2. 检查官方适配器是否提供同意/拒绝好友申请的方法。
3. 用另一个 QQ 号邀请 bot 入群，观察群邀请事件。
4. 检查是否有同意/拒绝群邀请的方法。

**通过标准**：

- 明确好友申请和群邀请的事件与处理方式。
- 如果官方没有人工审批接口，记录为“不可用”，不写入实现承诺。

**公开线索**：

- [用户添加好友](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html)
- [用户管理事件](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/user/manage/event.html)
- [nonebot-plugin-add-friends](https://github.com/hakunomiko/nonebot-plugin-add-friends)

## V0-5 / V0-6 频率限制与配额

**验证方法**：

1. 登录 QQ 开放平台后台，查看“频控 / 配额 / 调用限制”页面。
2. 在测试群按不同频率发送消息，记录触发限流的阈值和错误码。
3. 测试主动消息与被动消息的差异。
4. 测试可加入群数量和可管理群数量。

**通过标准**：

- 记录发送消息、拉取申请、群管操作的频率限制。
- 记录每日/每月配额和超限后的行为。
- 据此设计限流与重试策略。

**公开线索**：

- [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [官方 bot-docs send.md](https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)

## V0-7 个人开发者群聊权限

**验证方法**：

1. 登录 QQ 开放平台，检查当前机器人是否具有群聊能力入口。
2. 检查开发者主体的类型和可用能力。
3. 联系平台客服确认个人开发者政策。
4. 如果当前 AppID 不支持，记录为阻塞项。

**公开线索**：

- [QQ Bot 介绍与接入指南](https://bot.q.qq.com/wiki/bot_new_product-intro/)
- [QQ 平台入驻文档](https://q.qq.com/wiki/)
- [V2EX：官方 QQ 机器人所有人可使用群聊了](https://global.v2ex.co/t/1076038)
- [腾讯云文章：个人开发者接口问题](https://cloud.tencent.cn/developer/article/2697243)

## V0-8 内容安全 API

**验证项**：

- 价格与免费额度。
- 文本、图片、文件支持范围。
- 数据是否用于训练。
- 数据保留期限。
- 是否涉及跨境传输。
- 服务条款与合规要求。

**通过标准**：

- 选择至少一个境内可用服务。
- 明确数据使用条款。
- 按实际消息量估算月成本。

**公开线索**：

- [腾讯云文本内容安全](https://cloud.tencent.cn/document/product/1124/37119)
- [腾讯云内容安全服务条款](https://cloud.tencent.cn/document/product/301/120087)
- [阿里云审核智能体计费](https://help.aliyun.com/zh/document_detail/3013126.html)
- [OpenAI Moderation](https://developers.openai.com/api/docs/guides/moderation)
- [OpenAI Data controls](https://developers.openai.com/api/docs/guides/your-data)

## V0-9 部署与备份

**验证项**：

- 服务器架构：x86_64 / ARM64。
- Docker 与 Docker Compose 版本。
- 80/443 端口、域名解析、TLS 证书。
- PostgreSQL 数据卷和备份路径。
- 备份恢复演练。

**通过标准**：

- `docker compose config` 通过。
- 能启动数据库和 bot。
- 能完成一次 `pg_dump` 和恢复演练。

## V0-10 活动报名与信息导出

**验证方法**：

1. 确认官方 API 能否获取群成员列表、群成员基础信息和入群申请数据。
2. 确认活动报名能否完全通过机器人消息 + 数据库实现，还是必须依赖群成员列表。
3. 确认导出数据的字段范围、权限、脱敏和审计要求。
4. 确认官方 API 对高频读取、批量操作和导出的限制。

**通过标准**：

- 明确活动报名所需数据是否能从官方 API 获取。
- 明确信息导出的数据来源、权限和合规边界。
- 如果官方不提供成员列表，活动报名采用“用户主动报名”模式，导出数据仅包含用户主动提交的信息。

## 实测记录模板

```text
日期：
测试群：
AppID：
bot 身份：普通成员 / 管理员 / 群主

V0-1 全量消息：
- 是否收到：
- 事件类型：
- 是否需要申请：
- 备注：

V0-2 撤回他人消息：
- 普通成员身份：
- 管理员身份：
- 错误码：
- 时间窗口：
- 备注：

V0-3 入群审批：
- 是否收到申请事件：
- 审批接口：
- 备注：

V0-4 好友/群邀请：
- 好友事件：
- 群邀请事件：
- 是否有同意/拒绝接口：
- 备注：

V0-10 活动报名与信息导出：
- 是否有群成员列表接口：
- 可获取字段：
- 活动报名数据来源：
- 导出权限与脱敏要求：
- API 频率限制：
- 备注：
```

## 当前实测记录

最近一次 `pnpm phase0` 结果（未记录任何密钥）：

- `.env` 已成功加载：AppID、Client Secret、测试群 ID 均存在。
- 请求已到达官方 API，未出现 401/403 鉴权错误。
- `getJoinRequests` 返回：`400 请求的资源不存在(用户/群已注销)`。
- `sendGroupMessage` 返回：`400 请求的资源不存在(用户/群已注销)`。

当前判断：

- `QQ_BOT_TEST_GROUP_ID` 可能不是官方要求的 group openid，或填写了普通群号。
- 机器人可能尚未加入该测试群，或该群未开通对应能力。
- 需要继续核对官方文档中的接口路径与请求体。

下一步：

1. 确认 `QQ_BOT_TEST_GROUP_ID` 是官方文档中的 group openid。
2. 确认机器人已加入测试群并拥有群聊能力。
3. 在开放平台后台查看接口权限和事件订阅。
4. 再次运行 `pnpm phase0`。
