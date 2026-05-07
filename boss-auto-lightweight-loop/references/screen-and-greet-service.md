# Screen And Greet Service

## 定位

`screen-and-greet` 是推荐牛人页额度消耗 + 聊天页筛选求简历入口，覆盖两类来源：

- `recommended_feed`：推荐牛人页候选人，必须先处理；按本地 state 去重后逐个点击当前卡片内的“打招呼”，直到账号当日推荐牛人沟通额度耗尽、列表到底、无新增可触达候选人或安全暂停。
- `inbound_chat`：推荐页阶段结束后再处理；聊天界面候选人经筛选后发送求附件简历消息。

旧的 `screen-and-send` 已废弃为兼容别名。收到该 mode 时必须立即规范化为 `screen-and-greet`；不要再为它维护独立语义。聊天页候选人是否发送求附件简历消息，由 `screen-and-greet` 的来源规则决定。

## 固定阶段

每轮固定分为 6 个阶段：

1. `recommended_feed_quota_drain`：优先进入推荐牛人页，定位已渲染候选人卡片，按 state 去重后逐个点击“打招呼”，直到额度耗尽或列表停止。
2. `load_job_profile`：推荐页阶段结束后，按 `job_id` 优先读取岗位画像缓存，缓存缺失才读取在线 JD，用于聊天页筛选。
3. `discover_inbound_chat_candidates`：推荐页阶段结束后，发现聊天页本轮未读或最近活跃候选人。
4. `screen_inbound_chat_candidates`：只对聊天页候选人使用岗位画像和筛选标准生成 `rating`、`hard_filters_passed`、`decision`。
5. `send_resume_request_in_chat`：对聊天页达标候选人发送求附件简历消息。
6. `write_state_and_log`：做候选人级轻量 state 更新，向 JSONL 运行日志追加短事件，并记录可恢复原因。

推荐牛人页不先做 JD 评分筛选，也不打开详情做深度筛选；它只做候选人身份绑定、可打招呼按钮确认、重复触达过滤和安全检查。聊天页继续使用统一筛选标准和统一状态名。

## 来源读取规则

### inbound_chat

- 只在推荐牛人页额度消耗阶段结束后执行。
- 优先发现未读候选人；没有稳定未读信号时，再按可见新候选人和 state 去重补充。
- 使用左右分栏联动读取在线简历：先定位左侧候选人块，再确认右侧详情已切到同一人。
- 达标后在聊天输入框发送 `request_resume_message`。
- 发送确认成功后写入 `attachment_requested`。

### recommended_feed

- 先读取 `boss-recommend-read-recipe.md`。
- 当前页已有候选人卡片时，直接读取 DOM 卡片，不默认长等待、不截图、不要求用户确认页面是否加载完成。
- 本轮未处理判断主要依赖本地 state：无记录、`discovered`、`screened`、`eligible`，或上一轮只有 `last_observation` 失败记录但尚未触达。
- 不先读取详情、不做 JD 打分筛选；只要候选人未触达、身份可绑定、卡片内存在可点击“打招呼”按钮且没有安全阻断，就读取 `boss-greet-recipe.md`，按“候选人卡片 + 卡片内按钮”稳定绑定点击打招呼。
- Boss 侧预设打招呼语固定视为求附件简历消息；当前页确认打招呼成功后直接写入 `attachment_requested`。
- 相邻推荐候选人之间使用 `recommended_greet_interval_seconds_min` 到 `recommended_greet_interval_seconds_max` 的随机等待，默认 3-8 秒。
- 当前屏候选人处理完后，按 `boss-recommend-read-recipe.md` 的受控滚动/加载规则继续读新增卡片；直到出现 `paused_boss_contact_quota_exhausted`、无新增可打招呼候选人、列表到底、登录/验证码/弹窗阻断或连续候选人身份无法绑定。

## 聊天页准入

聊天页候选人进入求简历发送池必须同时满足：

```text
rating >= auto_send_threshold
and hard_filters_passed == true
and status not in sent_or_completed_states
and greeted_count_this_run < max_greet_per_run
```

默认 `auto_send_threshold=3`，即 3 星及以上可进入打招呼池。

`max_greet_per_run` 只控制聊天页求附件简历发送上限，不再截断推荐牛人页额度消耗。推荐牛人页的停止边界是平台沟通额度、列表停止条件、本地 state 去重和安全暂停。

`sent_or_completed_states` 包含：

- `first_contact_sent`
- `attachment_requested`
- `attachment_sent_by_candidate`
- `attachment_received`
- `resume_downloaded`
- `ready_for_hire_sync`
- `boss_completed`

## 触达动作

触达必须先做候选人身份校验，再执行动作：

- `inbound_chat`：输入并发送 `request_resume_message`，成功后 `attachment_requested`。
- `recommended_feed`：点击目标卡片内“打招呼”按钮；成功后 `attachment_requested`，并记录 `decision="auto_greet_recommended_quota_drain"`、`last_observation="recommended_greet_sent_request_resume"`。

聊天页相邻候选人之间使用 `send_interval_seconds_min` 到 `send_interval_seconds_max` 的随机短暂停顿；推荐页相邻候选人之间使用 `recommended_greet_interval_seconds_min` 到 `recommended_greet_interval_seconds_max`。

每处理 `health_check_every_candidates` 位候选人做一次轻量页面健康检查。检查只覆盖 Boss target 存活、当前 Boss 上下文、登录/验证码显性信号和页面可控状态；只有检查失败或连续动作失败时，才进入 recipe 的分层诊断。

## 后续跟进

`collect-resumes` 只跟进 `attachment_requested` 及以后状态。

`first_contact_sent` 只作为历史兼容状态保留，不是新推荐牛人页流程的目标状态。历史 `first_contact_sent` 候选人不进入附件回收；后续由 `follow-greeted` 或下一轮 `screen-and-greet` 在聊天界面发现其回复/会话后，再发送求附件简历消息并推进到 `attachment_requested`。

## 暂停边界

以下情况立即停止本轮：

- 登录失效、验证码、系统授权弹窗。
- 候选人身份无法唯一绑定。
- 下游 state 或日志写入失败。

以下情况只停止推荐牛人页阶段；若没有上面的整轮暂停条件，本轮继续进入聊天页筛选发送：

- 推荐牛人沟通权益耗尽。
- 连续点击无状态变化且已优先诊断为账号额度限制。

暂停态必须使用 `state-machine.md` 已注册名称，不新增临时 `paused_*`。
