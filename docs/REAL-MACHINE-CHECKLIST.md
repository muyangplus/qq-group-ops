# 真机待确认清单（Real-machine Checklist）

> 这里只列**必须真实 QQ 群环境**才能确认的项（本机无法复现）。跑完请把「实际观察」一栏贴回来，
> 我据此收尾对应 TODO 条目。执行前先 `pnpm build`，并按 [OPERATIONS.md](./OPERATIONS.md) 在仓库根目录启动。
>
> **想一次跑完**：直接照 [REAL-MACHINE-RUN.md](./REAL-MACHINE-RUN.md)（跑批手册：准备清单、执行顺序、
> 一键取证命令、回填模板）做，比逐项翻本文件快得多；本文件负责解释每项的背景与判定标准。
>
> 相关：`docs/ACCEPTANCE.md`（J1–J66 完整验收）、`TODO.md`（条目状态）。


## A. 官方能力 / 表示待确认（决定要不要实现）

> **日志级别**：R1 的 `@全体` 候选按 **info** 级记录，默认开箱即见（一次一条，只记形状不记正文）。
> 如果还想看**普通 @某人** 的原文，把 `LOG_LEVEL=debug` 后重启，这时会额外出现
> `mention probe: mention-like content`；同一条日志里的 `stripped` 为 `false` 且 `isCommand` 为 `false`
> 说明该提及格式**没被识别**（需要补 `stripBotMention` 规则）。
>
> **未处理事件探针**：任何本项目还没实现的事件类型，都会按 **info** 级记一条
> `unhandled official event (ignored)`，带 `eventType` 与 payload 的**顶层字段名**（不记值、不含隐私，
> 同一类型只记一次）。R2（用户撤回）、R18（好友申请 / 被拉进群）都靠它取证 —— 统一用
> `grep "unhandled official event" logs/qq-group-ops.log` 看结果。

| # | 待确认 | 怎么测 | 预期/观察点 |
|---|---|---|---|
| R1 | **别人发「@全体成员」在事件里长什么样**（B3） | 让群成员发一条 @全体 消息（可以带内容也可以不带）；然后 `grep "mention probe" logs/qq-group-ops.log`；再私信发 `/testat all` 作对照 | ✅ **已确认（2026-09-26）**：`@全体成员` → **`<@all> `**（`rawLength=7`、`hasAngleMention=true`、无不可见字符）；`@everyone` → **`@everyone`**（`rawLength=9`）。两者 `cleanedLength=0` 且被路由成 `command: "menu"`——即**原来会抢答常用菜单**。B3 已据此实现（见 R16） |
| R2 | **用户撤回消息是否有下行事件**（B7 口径扩展） | 让成员发消息后撤回；然后 `grep "unhandled official event" logs/qq-group-ops.log`（撤回类事件会以**未处理事件**的形式记下来） | 有 → 可以把「撤回后通知」扩到用户撤回；没有 → 保持现状（只推机器人自己的处罚） |
| R3 | **文本 / 图片内容审核接口是否存在**（B4/B5） | ① 开放平台后台 → 机器人 → 「开发设置 / 权限」里逐项找：`内容安全`、`消息审核`、`文本审核`、`图片 / 媒体审核`、`msg_sec_check`、`敏感词`；② 若权限集里有任一项，点进去抄下**权限名 + 对应接口路径**发我；③ 都没有的话，到文档站 api-v2 再搜一遍 `sec_check` / `内容安全` 确认 | 公开文档目前只能确认**小程序**体系的 `msgSecCheck`，**机器人 api-v2 未见内容安全接口**（2026-09-26 检索）→ 有权限集+接口才实现 B4/B5，否则保持「能力未确认」，不做盲接口 |
| R4 | **官方群拉黑接口是否对本机器人开放**（A5） | `/blacklist add <小号>`，看日志里 `updateMemberBlacklist` 的返回 | 成功 → 官方拉黑生效；`11253` 等 → 只有本地拦截生效（当前已在日志与卡片文案里区分） |

## B. 交互行为抽查（0.12.0 / 0.13.0 新功能）

| # | 项目 | 步骤 | 预期 |
|---|---|---|---|
| R5 | `/whois` 群内完全静默（A3/A4） | 群里发 `/whois <某人>`；再换一个没私聊过机器人的号发一次 | 成功：群里一条消息都没有；私信失败：群里只有一条 @发起人 的「请先私聊机器人再试」 |
| R6 | 默认菜单与入口暴露（F2 / J60） | 成员发 `/menu`、空 @机器人、私信首次交互；管理员群里发 `/menu` 与 `/menu 管理`；超管群里发 `/menu 超管`、私信发 `/menu` | 默认=常用菜单；群里**不出现**管理/超管按钮；超管菜单仅私信；私信里对有权者显示管理/超管按钮 |
| R7 | 群内回复首行 @ 发起人（F1 / J61） | 群里发 `/menu`、`/status`、`/rules`；点一次群内回调（如「刷新」）；再发 `/test`、`/testmenu`；私聊发 `/menu` | 每条群内回复**首行 @ 到人**（回调回复也算）；`/test*` 与私聊不加 @ |
| R8 | 处罚推送 + 卡片改处罚（B7 / J57） | 审核员 `/notify punish on`；小号发命中关键词的消息 | 审核员私信收到处罚卡；点「禁言时长 → 1小时」「解除处罚」都生效；群里不发处罚通知 |
| R9 | 黑名单最高优先级 + 申诉闭环（A5/B8 / J58/J59） | 按 J58/J59 步骤执行 | 黑名单命中直接拒绝（即使 `autoApprove on`）；申诉群里静默、审核员卡上可「通过/驳回/调整处罚」 |
| R10 | 规则开关与恢复继承（批次2 记录项） | 在 `/rules` 子卡点开关；点「恢复本页继承」「恢复全部继承」 | 标签变「当前状态」，恢复后回落继承，重启后保持 |
| R11 | 正则 + 白名单（B1 / 0.14.0） | `/rules add regex \d{8,}`，用小号发 8 位数字；`/rules add whitelist <小号QQ>` 后再发一次 | 第一次按本群「命中处罚」执行并写审计；加入白名单后完全不处理（无警告/无审计） |
| R12 | 审核日志导出（B6 / 0.14.0） | 群管理员群里发 `/export audit 20` | 群里静默；本人私信收到脱敏 CSV（不含完整 openid），审计里多一条 `export_audit_records` |

## C. 交付验证

| # | 项目 | 步骤 | 预期 |
|---|---|---|---|
| R13 | Docker Compose（D2） | 启动 Docker Desktop 后：`docker compose -p qqops-smoke build bot`；`POSTGRES_PASSWORD=<临时> docker compose -p qqops-smoke --profile postgres up -d db`；`docker compose -p qqops-smoke ps` | 镜像构建成功；db 容器 healthy；测完 `docker compose -p qqops-smoke --profile postgres down -v` 清掉（不要用默认项目名，避免污染真实数据卷） |
| R14 | 快速开始复现（D3 已本机验证，真机再走一遍） | 按 OPERATIONS「快速开始」从零：填 `.env` → `pnpm dev` | 收到 `gateway ready: bot authenticated`；群里发 `/test` 有自检卡 |
| R15 | 真机验收 J32–J61 + M 组（D4） | 按 `docs/ACCEPTANCE.md` 逐条执行并记录 | 全部通过或记录差异 |
| R16 | **`@全体` 不再被抢答**（B3，R1 的修复复验） | 群里依次发：① `@全体成员`（不带内容）② `@everyone` ③ `@全体成员 大家好` ④ `@全体成员 /menu` ⑤ 空 `@机器人` | ①②：机器人**一条都不回**（日志只有 `mention probe: skipped at-all mention`，`/audit` 无记录）；③：按普通发言审核（命中关键词照常处理）；④：照常执行 `/menu`；⑤：仍然回常用菜单（不能被误伤） |
| R17 | **机器人能不能自己 @全体**（决定活动「提醒全体」能不能做） | 群里发 `/testat all`（仅超管，会给全群发 11 条），观察**哪几条真的提醒了全群**（昵称/「全体成员」高亮、手机通知）；把汇总卡里对应编号回报 | ✅ **已确认（2026-09-26，否定）**：8 条候选（含 R1 抓到的官方原文形态 `<@all>` 卡片/纯文本、纯文本 `@everyone`）**全部不会提醒任何人** → 定论「**机器人无法 @全体**」。活动 `提醒@全体`（`mentionAll on`）保持现状：只提示操作者手动 @，不假装能 @；除平台后续开放能力，无需再跑本条 |
| R18 | **好友申请 / 机器人被拉进群有没有事件**（A2） | ① 让一个小号**加机器人为好友**；② 把机器人**拉进一个新群**（或先退群再被拉回）；然后 `grep "unhandled official event" logs/qq-group-ops.log` | 官方文档有[「用户添加好友」](https://bot.qq.com/wiki/develop/api-v2/autogen/event/friend_add.html)与[「机器人加入群聊」](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_add_robot.html)两页，说明事件存在；真机日志里应出现对应 `eventType` + `dataKeys`。**若一条都没有** → 可能是当前 intent 没订阅到（把日志发我，我加 intent 覆盖项再试），或平台未对这些场景推事件 |

## 回填方式

把结果按 `R编号：实际观察` 的形式贴给我即可（截图/日志片段更好）。我会：
- 能直接修的立刻修（如 R1 得出 @全体 表示 → 实现 B3；R3 确认有接口 → 实现 B4/B5）；
- 只是记录差异的写进 TODO「记录」条目，不阻塞其他批次。
