---
name: boss-auto-lightweight-loop
description: 自动化 Boss 直聘轻量招聘前半段闭环：基于本地 screening-policy 自动筛选候选人，达标后自动打招呼/求附件简历，并在后续只跟进已触达候选人，接收附件、下载简历、落本地状态并生成可交给飞书招聘同步任务的候选人快照。适用于“自动筛选候选人”“自动打招呼求简历”“收简历下载到本地”“跑 Boss 触达与收件闭环”等任务。
---

# Boss Auto Lightweight Loop

# Version
2026-05-07-v8

## 定位

本 skill 是编排层。`SKILL.md` 只保留入口、边界和事实源导航；详细流程、状态结构、配置值和动作 recipe 放在 references 或 assets 中，避免多处双写。

唯一事实源：

- 默认配置：`assets/default-config.yaml`
- 状态名、状态字段和可恢复语义：`references/state-machine.md`
- 自动化 / `runtime=lite` 运行 delta：`references/runtime-lite.md`
- Boss 浏览器执行器与路由：`references/browser-routing.md`
- 站内发送原子动作：`references/boss-send-recipe.md`

若 `runtime-lite.md`、workflow 或 recipe 与上述事实源冲突，以 `assets/default-config.yaml` 和 `references/state-machine.md` 为准。

自动化、定时任务、无人值守场景：

- 默认读取本 skill 的 `references/runtime-lite.md`、`assets/default-config.yaml`，以及当前 `mode` 的最小必读 reference 清单。
- `runtime-lite.md` 只描述自动化运行 delta：上下文读取、运行锁、短输出、失败即停、推荐页额度边界、聊天页小批量和恢复边界。
- `runtime-lite.md` 不维护完整筛选、发送、附件回收、状态机或配置副本；业务细节按需读取对应 reference。
- 当前 `mode` 必读清单之外的 reference，只有发生异常、规则缺失、用户要求解释/改策略时才读取。
- 只要用户提示或自动化任务 message 中出现 `runtime=lite`，就按无人值守自动化场景处理。

## 核心目标

把下面链路自动化，但保持可恢复、可审计，并对推荐牛人页使用平台权益额度作为本轮停止边界：

```text
screen-and-greet 先处理推荐牛人页
→ 推荐页按状态去重后逐个点击“打招呼”，直到平台沟通额度耗尽、列表到底或安全暂停
→ 再进入聊天页筛选候选人并发送求附件简历消息
→ 对已发送求附件简历消息的候选人回收附件
→ 只跟进本轮已触达候选人
→ 通过 `web-access` CDP Proxy 接收附件并下载
→ 更新本地状态与候选人快照
→ 生成可供“飞书招聘同步 skill”直接消费的本地待同步队列
```

## 硬规则

- 所有场景：Boss 页面读取、点击、线程切换、发送、接收附件、下载附件必须固定走 `web-access` CDP Proxy。
- `web-access` 只能复用用户当前已经登录的 Boss 招聘者网页端 tab，并通过 `/targets`、`/info`、`/eval`、`clickAt`、CDP 鼠标事件和 DOM 探针执行；不得新开普通 Boss tab。
- `web-access`/Chrome 远程调试授权只能在入口检查阶段完成一次；同一轮 `screen-and-greet` 必须复用已授权 CDP Proxy、`targetId` 和最近有效探针，禁止每处理一位推荐牛人就重新触发远程调试授权或系统确认弹窗。
- 不得退回 `opencli boss`、站点适配器、额外浏览器封装或其他执行器。
- 默认禁止截图、OCR、图像理解。
- 发送站内消息和推荐牛人页打招呼必须执行固定路径；自动化场景按当前 `mode` 的必读清单加载对应 recipe，不在 lite 文档中维护第二份发送实现。
- 推荐牛人页打招呼在 `screen-and-greet` 中优先执行：先定位推荐页候选人列表，按候选人卡片稳定绑定“打招呼”按钮，逐个点击，直到账号当日推荐牛人沟通额度耗尽、列表到底、无新增可打招呼候选人或出现安全暂停条件。
- 推荐牛人页不再受 `max_greet_per_run` 截断；它的停止边界是平台沟通权益、列表停止条件、本地 state 去重和安全暂停。相邻候选人之间必须按 `recommended_greet_interval_seconds_min/max` 随机等待，默认 3-8 秒。
- 聊天页求附件简历发送仍必须使用自动准入规则、加间隔、做候选人身份校验，并由 `max_greet_per_run` 控制本轮聊天页发送上限。
- 候选人唯一标识统一为 `candidate_id`；优先由 `候选人姓名 + 学校` 标准化生成，学校缺失时退化为 `候选人姓名`，并在同名冲突时追加来源侧稳定标识。
- 筛选阶段只允许基于候选人卡片、在线简历区域和真实消息气泡判断；不得把底部快捷话术、输入框占位词、按钮栏文本当作 `last_message`、拒绝信号或历史聊天内容。
- 推荐牛人页直接读取当前已渲染卡片并用本地 state 判断未处理；本阶段不先做 JD 评分筛选，不打开详情做深度筛选，只做候选人身份绑定、重复触达过滤和可打招呼按钮确认。推荐页额度耗尽或列表到底后，聊天页筛选读取才发现本轮未读候选人集合，再用卡片快照做快筛；只有可能达标或信息不足的聊天候选人才打开详情读取，且必须做身份校验。
- 附件回收阶段只检查本 skill 状态文件中已触达的候选人，不扩大扫描。
- 遇到验证码、登录失效、身份不匹配、连续发送失败、下游队列写入失败，立即停止本轮。
- 自动化运行默认即时追加 JSONL 事件日志，候选人状态可按 `state_flush_batch_size` 批量 flush；遇到暂停态、失败态、下载完成、队列写入成功/失败或本轮结束必须立即 flush。
- `screen-and-greet` 和 `dry-run` 至少要为每个扫描候选人生成最小 state 变更。推荐牛人页额度消耗阶段至少包含 `source`、`decision`、`skip_reason` 或 `last_observation`；聊天页筛选阶段至少包含 `source`、`rating`、`hard_filters_passed`、`skip_reason` 或 `decision`。自动化场景可批量 flush。
- 本 skill 不直接调用飞书招聘 Hire 接口；飞书招聘入库由独立同步 skill 消费本地状态与下载好的简历文件完成。

## 默认运行模式

优先使用两段式，不建议首次直接跑无限 `full-cycle`：

- `screen-and-greet`：先在推荐牛人页按 state 去重逐个点击“打招呼”，直到推荐沟通额度耗尽、列表到底或安全暂停；再进入聊天页筛选候选人并发送求附件简历消息。
- `follow-greeted`：兼容历史状态；只检查旧数据中仍停留在 `first_contact_sent` 的候选人，若进入聊天/有回复，再发送求附件简历消息并推进到 `attachment_requested`。新推荐牛人页流程不再产生 `first_contact_sent`。
- `collect-resumes`：只跟进已发送求简历的候选人，接收附件、下载、更新本地状态并生成待同步队列。
- `full-cycle`：先执行 `screen-and-greet`，再尝试回收已进入 `attachment_requested` 的附件并写入本地待同步队列；只适合小批量试运行。
- `dry-run`：只筛选和生成候选人池，不发送、不点击、不写本地队列。

`screen-and-send` 已废弃为旧入口别名。若用户、脚本或历史定时任务传入 `screen-and-send`，必须立即规范化为 `screen-and-greet` 执行；不要为它维护单独语义、单独流程或单独输出模式。

若用户未指定模式，默认：

```text
dry-run
```

只有用户明确要求自动发送、打招呼或自动跑闭环时，才进入 `screen-and-greet` 或 `full-cycle`。

## 默认配置

先读取本 skill 随附配置：

```text
/Users/apple/.codex/skills/boss-auto-lightweight-loop/assets/default-config.yaml
```

若运行环境将 skill 镜像到其他目录，再读取镜像路径下的同名 `assets/default-config.yaml`，但两者冲突时以当前加载的 skill 路径为准。
若用户提供了新参数，以用户参数覆盖默认值。

关键约束：`job_name` 默认留空，必须由用户、cron prompt 或当前 Boss 岗位上下文显式提供；不得依赖 `SKILL.md` 中的硬编码岗位名运行。

配置值不要复制到 `SKILL.md`。需要默认值时直接读取 `assets/default-config.yaml`。

## 执行导航

按任务需要读取下列 reference：

- 自动化运行 delta：`references/runtime-lite.md`
- 统一筛选打招呼服务：`references/screen-and-greet-service.md`
- 推荐牛人页卡片读取：`references/boss-recommend-read-recipe.md`
- 推荐牛人页卡片打招呼：`references/boss-greet-recipe.md`
- 完整工作流：`references/workflow.md`
- 状态机与 JSON 结构：`references/state-machine.md`
- 自动筛选与准入策略：`references/screening-policy.md`
- Boss 聊天与附件回收规则：`references/boss-chat-rules.md`
- Boss 浏览器执行器与路由：`references/browser-routing.md`
- 站内发送原子动作：`references/boss-send-recipe.md`
- 自动化本地运行锁：`references/automation-lock.md`
- 飞书招聘同步交接说明：`references/feishu-archive.md`

可复用本地脚本入口：

- `scripts/boss_lite_screen_and_greet.mjs`：`runtime=lite` 下的本地一体化 `screen-and-greet` 执行器；先处理推荐页打招呼，再进入聊天页筛选并给达标候选人发送求附件简历消息。适合自然语言要求“runtime=lite，mode=screen-and-greet”时直接运行。
- `scripts/screen_recommend_loop.js`：推荐牛人页按 state 去重点击打招呼；这是 `screen-and-greet` 的推荐页阶段脚本，不等同于完整 `screen-and-greet`。
- `scripts/send_resume_requests.js`：聊天页对已筛选达标候选人发送求附件简历消息；只消费 state 中 `source="inbound_chat"`、`rating >= auto_send_threshold` 且 `hard_filters_passed=true` 的候选人，不负责筛选。
- `scripts/collect_visible_resumes.js`：聊天页只跟进已触达候选人的附件简历信号。

自然语言执行 `screen-and-greet` 时必须按工作流执行完整两段：先执行推荐页额度消耗阶段；随后进入聊天页发现和筛选候选人，写入 `rating`、`hard_filters_passed`、`decision` 等最小 state；最后才调用或等价执行聊天页求附件简历发送阶段。不要把 `scripts/screen_recommend_loop.js` 的完成误判为整个 `screen-and-greet` 完成。

自动化、定时任务、无人值守、`runtime=lite` 场景不得只读 lite 文档后直接执行；必须按当前 `mode` 读取下列最小必读 reference：

- `dry-run`：`runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`screen-and-greet-service.md`、`screening-policy.md`、`workflow.md`、`browser-routing.md`、`boss-recommend-read-recipe.md`。
- `screen-and-greet` / `screen-and-send`：`runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`screen-and-greet-service.md`、`screening-policy.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`、`boss-recommend-read-recipe.md`、`boss-greet-recipe.md`。
- `follow-greeted`：`runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`。
- `collect-resumes`：`runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`、`feishu-archive.md`。
- `full-cycle`：先读取并执行 `screen-and-greet` 清单，再读取并执行 `collect-resumes` 清单。

不要默认加载当前 `mode` 清单之外的 reference；只有缺少关键字段、发生异常、用户要求解释/改策略时，才按需读取对应详细文件。

执行顺序必须是：

1. 启动前检查。
2. 加载默认配置与本地状态。
3. 按模式执行工作流。
4. 每个候选人按状态机推进，并即时追加简短 JSONL 事件。
5. 按批量 flush 策略写入本地状态；待同步队列写入成功后不得延迟对应恢复标记。
6. 汇报本轮完成、跳过、暂停、失败和可重跑入口。

## 本地运行锁要求

自动化、定时任务、无人值守、`runtime=lite` 场景启动后，必须先执行本地运行锁检查。

默认锁目录：

```text
/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto.lockdir
```

规则：

- 获得锁后才能执行浏览器读取、点击、发送、下载和本地状态写入。
- 如果锁已存在且未超过 `lock_ttl_minutes`，本轮必须跳过，并输出短 JSON：`{"status":"skipped","reason":"lock_exists"}`。
- 如果锁已超过 `lock_ttl_minutes`，视为陈旧锁，可删除后重新获取。
- 正常结束、异常暂停、发送失败、下载失败、队列写入失败时，都必须释放本轮获得的锁。
- 获取锁后写入 `meta.json`，至少包含 `pid`、`mode`、`started_at`、`host`。

详细规则见 `references/automation-lock.md`。

## 完成汇报格式

自动化、定时任务、无人值守、`runtime=lite` 场景以 `references/runtime-lite.md` 的短 JSON 输出格式为准，不输出长 Markdown 复盘。

非定时任务场景结束时用中文简洁汇报：

- 本轮模式。
- 扫描候选人数。
- 达标候选人数。
- 自动打招呼人数。
- 聊天页求附件简历发送人数。
- 接收附件人数。
- 下载成功人数。
- 本地归档成功人数。
- 待同步队列写入成功人数。
- 暂停/失败候选人及原因。
- 下一次安全重跑应从哪个模式继续，以及是否已经进入飞书招聘同步队列。
