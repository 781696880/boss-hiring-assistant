# Runtime Lite

`runtime=lite` 用于自动化、定时任务和其他无人值守运行。它不是第二套 workflow，也不是配置、状态机或发送 recipe 的副本；本文件只描述自动化运行相对人工运行的差异，并规定每个 mode 的最小必读 reference 清单。

## 边界

本文件只负责：

- 限制自动化运行时的上下文读取范围。
- 定义各 mode 启动前必须读取的最小 reference 集合。
- 定义无人值守任务的锁、失败即停、短输出和推荐页额度消耗边界。
- 约束自动化任务如何使用 `web-access` CDP Proxy、如何恢复、如何避免扩大影响。

本文件不负责：

- 定义默认配置值。
- 定义候选人状态名和 JSON schema。
- 复述完整筛选、打招呼、发送、附件下载流程。
- 复述页面 DOM 读取、发送按钮点击或附件下载的完整 recipe。
- 绑定任何具体自动化平台或调度器。

## 事实源

自动化任务默认先读取：

```text
references/runtime-lite.md
assets/default-config.yaml
```

然后必须按当前 `mode` 读取对应最小必读 reference。清单之外的文档只在异常诊断、规则缺失或用户要求解释/改策略时读取。

事实源：

- 配置默认值：`assets/default-config.yaml`
- 状态名、状态字段、可恢复语义：`references/state-machine.md`
- 完整 workflow：`references/workflow.md`
- 统一筛选打招呼入口：`references/screen-and-greet-service.md`
- 筛选准入与评分口径：`references/screening-policy.md`
- 推荐牛人页读取：`references/boss-recommend-read-recipe.md`
- 推荐牛人页打招呼：`references/boss-greet-recipe.md`
- 聊天页发送和附件回收：`references/boss-chat-rules.md`
- 站内发送原子动作：`references/boss-send-recipe.md`
- `web-access` 路由细节：`references/browser-routing.md`
- 本地运行锁：`references/automation-lock.md`
- 飞书招聘交接：`references/feishu-archive.md`

如果本文件与配置或状态机冲突，以 `assets/default-config.yaml` 和 `references/state-machine.md` 为准。

## 读取策略

- 自动化入口提示中出现 `runtime=lite` 时，按本文件执行。
- 不要默认加载完整 reference；按当前 `mode` 的最小必读清单加载，只有当前动作确实需要额外细节、发生异常、规则缺失或用户要求解释/改策略时，才加载清单外 reference。
- 运行日志只向 `run_log_jsonl_file` 或 `run_log_dir` 下的当日 JSONL 追加单行结构化摘要和必要错误码；不要写整页 `innerText`、完整聊天历史、完整简历正文或大段自然语言。
- 最终回复只输出短 JSON；不要输出长 Markdown 复盘或候选人长明细。

## Mode 必读 Reference

`runtime=lite` 不能只读 lite 文档后直接执行；启动锁检查后、执行业务动作前，必须按 `mode` 加载下列最小文档：

- `dry-run`：
  `runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`screen-and-greet-service.md`、`screening-policy.md`、`workflow.md`、`browser-routing.md`、`boss-recommend-read-recipe.md`。
- `screen-and-greet` / `screen-and-send`：
  `runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`screen-and-greet-service.md`、`screening-policy.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`、`boss-recommend-read-recipe.md`、`boss-greet-recipe.md`。
- `follow-greeted`：
  `runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`。
- `collect-resumes`：
  `runtime-lite.md`、`default-config.yaml`、`state-machine.md`、`workflow.md`、`browser-routing.md`、`boss-send-recipe.md`、`boss-chat-rules.md`、`feishu-archive.md`。
- `full-cycle`：
  先按 `screen-and-greet` 清单执行，再按 `collect-resumes` 清单执行。

## 配置 Delta

- 默认值只从 `assets/default-config.yaml` 读取；用户参数、定时任务 prompt 或当前 Boss 岗位上下文可以覆盖。
- `job_name` 或 `job_id` 必须显式可得；不得依赖文档里的硬编码岗位名。
- 自动化运行必须使用配置中的上限和超时：`max_greet_per_run`、`max_collect_per_run`、`max_scan_per_run`、`max_detail_reads_per_run`、`max_list_scroll_rounds`、发送间隔、推荐页打招呼间隔、短超时、`lock_dir`、`lock_ttl_minutes`。
- `collect-resumes` 必须使用 `download_poll_interval_ms` 和 `download_max_wait_seconds` 控制下载完成轮询，不使用无界等待。
- 自动化运行必须使用 `health_check_every_candidates` 控制轻量页面健康检查频率；默认按配置每处理 10 位候选人检查一次，可按用户要求设为 5 到 10。
- 自动化运行必须使用 `state_flush_batch_size` 控制 state 批量 flush；默认 3，允许用户覆盖为 3 到 5。
- `probe_reuse_enabled=true` 时，同一 Boss 页面上下文中的连续 DOM 读取和连续推荐页卡片处理可以复用已通过探针的 `targetId`，只在页面切换、target 异常、健康检查周期或动作失败后重新探针。
- 远程调试授权或系统确认只允许在入口检查阶段出现一次；`screen-and-greet` 的推荐页逐个打招呼阶段必须复用已授权连接和 target，不得每位候选人重新触发授权弹窗。
- `thread_fast_switch_enabled=true` 时，聊天页相邻候选人可以复用已验证的左侧列表和右侧面板结构，直接点击下一张相邻卡片切换；仍必须做目标候选人身份校验。
- `recommended_feed_quota_drain_first=true` 时，`screen-and-greet` 必须先处理推荐牛人页并逐个点击“打招呼”，直到推荐牛人沟通额度耗尽、列表到底、无新增可打招呼候选人或安全暂停。
- 推荐牛人页相邻打招呼必须使用 `recommended_greet_interval_seconds_min/max`，默认 3-8 秒。
- `max_greet_per_run` 只控制推荐页结束后的聊天页求附件简历发送成功数；不要再使用 `daily_target` 或 `max_send_per_run`。
- `max_collect_per_run` 是 `collect-resumes` 中唯一附件回收处理上限，按候选人计数，达到后停止本轮并建议下次继续 `collect-resumes`。
- `aggressive_prefilter_enabled=false` 默认保持召回；只有用户明确选择快速档或历史评估显示预过滤准确率足够高时，才使用 `fast_max_detail_reads_per_run` 或提高 `auto_send_threshold`。

## 速度 Delta

自动化运行优先“小事务、短确认、轻日志”：

- 候选人状态变更先缓存在内存中，每累积 `state_flush_batch_size` 位候选人、遇到 `paused_*`、发送失败、下载失败、队列写入失败、下载完成、队列写入成功或本轮结束时统一 flush 到本地 state；运行日志仍按事件即时追加 JSONL。写入只更新 active state 中恢复所需的轻量字段，长筛选理由、长页面片段和原始聊天上下文写入 `archive_file` 或省略。
- 每个候选人状态变化只追加一条精简 `history` 事件；事件字段控制在 `at`、`action`、`from`、`to`、`result`、`error_code`、`run_id`、`source`。
- 发送站内消息后只做短确认：优先看输入框清空、目标线程最后一条真实消息短摘要或当前卡片状态变化；不要长等“已读”或“送达”。
- 附件下载成功并完成本地 hash 校验后，标记 `resume_downloaded`；采用批量化 flush 时，该状态在批次统一写入时落盘。
- 同步队列 JSONL 写入成功后，标记 `ready_for_hire_sync` 并立即 flush，避免队列与 state 不一致。
- 给候选人发送“简历已收到”回复并短确认成功后，标记 `boss_completed`；采用批量化 flush 时，该状态在批次统一写入时落盘。
- 每处理 `health_check_every_candidates` 位候选人做一次轻量页面健康检查，只检查 target 存活、Boss 上下文、登录/验证码显性信号、当前页面可控状态；不要每步做大诊断。
- 只有轻量健康检查失败、连续动作失败或出现暂停态时，才进入对应 recipe 的低 token 分层诊断。
- 同一页面内的连续读取可复用最近一次成功探针，不要在每张推荐卡片或每个轻量 DOM 读取前重复 `/targets` + `/info`；页面切换、线程切换失败、下载预览打开/关闭、target 重建或健康检查周期到达时必须重新验证。
- 同一推荐牛人页内的连续打招呼必须是“已授权连接 + 已绑定 target + 卡片内按钮”的串行动作；不要把 web-access 启动、Chrome 远程调试授权或系统弹窗确认放进候选人级事务。
- `candidate_sources` 只用于来源开关和兼容输出；`screen-and-greet` 的实际顺序固定为先 `recommended_feed`，再 `inbound_chat`。不要并行跑两个来源；单 Boss tab、单运行锁和页面状态共享会让并行来源更容易误发或误收。
- 岗位画像缓存命中时直接复用；外部脚本可以预热 `job_profile_cache_dir`，但本 skill 不在运行中为了预热额外扩大 Boss 页面读取。
- 卡片预过滤可以减少详情读取，但默认不提高 `auto_send_threshold`，避免静默改变招聘准入口径。

JSONL 运行日志单行建议字段：

```json
{"at":"2026-05-07T10:30:00+08:00","run_id":"...","mode":"collect-resumes","candidate_id":"...","action":"download_resume","status_from":"attachment_received","status_to":"resume_downloaded","result":"ok","error_code":null}
```

## 运行锁 Delta

自动化任务在执行任何浏览器读取、点击、发送、下载或本地状态写入前，必须先获得本地运行锁。

锁规则只保留自动化差异：

- 锁目录和 TTL 从 `assets/default-config.yaml` 读取。
- 锁未过期时直接跳过本轮，并输出短 JSON。
- 锁过期时可按 `references/automation-lock.md` 删除陈旧锁并重试一次。
- 正常完成、异常暂停、发送失败、下载失败、队列写入失败时，都必须释放本轮获得的锁。
- 只有本轮成功创建的锁才允许释放。

锁冲突输出：

```json
{"status":"skipped","reason":"lock_exists","mode":"screen-and-greet"}
```

## 浏览器 Delta

- 自动化任务固定使用 `web-access` CDP Proxy 执行 Boss 页面读取、点击、线程切换、发送、接收附件和下载动作。
- `web-access` 只允许复用当前环境中已经登录的 Boss 招聘者 tab；不要新开普通 Boss tab、窗口或浏览器上下文。
- 必须直接使用 CDP Proxy API，不要调用 `opencli boss chatlist/resume/chatmsg` 这类二次封装适配器。
- 页面读取和点击默认串行执行；不要并发发起多个 Boss 页面读取、线程切换、发送或下载动作。
- 不并行处理 `inbound_chat` 和 `recommended_feed`。若未来要并行化，必须拆成两个独立登录上下文、独立 target、独立 lock 和独立状态分片；当前 lightweight loop 不支持。
- 禁止默认截图、OCR、图像理解或额外浏览器工具；只有用户明确要求诊断时才另行处理。
- 遇到验证码、登录失效、系统授权弹窗、身份不匹配、页面不可控或下游队列写入失败，立即停止本轮。

`web-access` 的 target 重绑定、CDP eval、clickAt、DOM 读取和截图边界见 `references/browser-routing.md`。

## 模式 Delta

自动化任务只允许执行入口指定的 `mode`，不得自行扩大范围。

- `dry-run`：只读取、评分、写最小筛选 state 和运行日志；不发送、不接收附件、不下载、不写同步队列。
- `screen-and-greet`：按 `screen-and-greet-service.md` 先消耗推荐牛人页额度，再进入聊天页筛选发送；推荐页达到额度耗尽/列表到底/无新增可触达候选人后继续聊天页，聊天页达到 `max_greet_per_run`、扫描/详情/列表上限或安全暂停条件即停止。
- `screen-and-send`：deprecated alias；收到后必须立即规范化为 `screen-and-greet`，不得维护单独流程或单独输出模式。
- `follow-greeted`：只处理 state 中已 `first_contact_sent` 且尚未求附件简历的候选人；不扫描推荐牛人页新候选人，不接收附件。
- `collect-resumes`：只处理状态机允许恢复的附件回收候选人；不扩大扫描，不重复索要，不重复下载已有 `resume_hash` 的候选人。
- `full-cycle`：只适合小批量试运行；候选人异步回复不会强求同轮闭环。

具体业务流程和状态推进以 `workflow.md`、`screen-and-greet-service.md`、`boss-chat-rules.md`、`state-machine.md` 为准。

## 状态 Delta

- 自动化运行读取 state 时优先投影本轮需要的 active 字段；不要把完整 state 粘贴进最终输出。
- 写回 state 必须兼容历史根结构：数组根仍按数组写回，对象根仍按对象写回，不在自动化运行中静默迁移。
- 每个扫描候选人都必须生成或刷新最小筛选 state 变更，便于复盘没有进入打招呼池的原因；自动化运行可按 `state_flush_batch_size` 批量落盘，但 JSONL 事件必须即时追加。
- 详细匹配理由、风险点和较长历史写入 `archive_file` 或运行日志；active state 只保留恢复所需字段。
- 状态写回优先做候选人级轻量字段更新；除初始化、结构修复或用户要求迁移外，不重写与本轮候选人无关的大字段。
- 状态名、可恢复失败态和暂停态只使用 `state-machine.md` 已注册名称。

## 失败 Delta

自动化任务无人值守，失败策略是“短诊断、可恢复、立刻停”，不是长时间探索。

立即暂停的典型原因：

- 登录失效或验证码。
- 候选人身份无法确认。
- 线程切换失败。
- 右侧简历区域无法稳定命中。
- 发送确认超时或连续发送失败。
- 推荐牛人沟通权益疑似耗尽时结束推荐页阶段；若没有登录、验证码、身份错配、页面不可控等安全暂停，本轮继续进入聊天页筛选发送。
- 附件接收、下载或同步队列写入失败。
- 本地 state、日志或 archive 写入失败。

暂停时只写结构化原因、当前 mode、已完成计数和建议下次入口；不要请求用户在同一自动化轮次里人工介入。

## 输出 Delta

所有自动化模式结束时只输出一行 JSON。字段可以按 mode 增减，但必须包含：

```json
{
  "status": "ok|skipped|paused|failed",
  "mode": "screen-and-greet",
  "scanned": 0,
  "eligible": 0,
  "greeted": 0,
  "sent": 0,
  "received": 0,
  "downloaded": 0,
  "queued": 0,
  "skipped": 0,
  "failed": 0,
  "paused_reason": null,
  "next": "collect-resumes"
}
```

输出约束：

- `paused_reason` 使用 `state-machine.md` 中的暂停态或可恢复失败态名称。
- `next` 必须是安全重跑入口，例如 `screen-and-greet`、`follow-greeted`、`collect-resumes` 或 `retry_after_read_flow_fix`。
- 不输出完整候选人列表；如需审计，写入本地日志或 archive。
