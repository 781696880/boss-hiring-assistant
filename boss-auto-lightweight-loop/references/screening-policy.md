# Screening Policy

## 候选人来源

`screen-and-greet` 支持：

```text
inbound_chat
recommended_feed
```

其中 `inbound_chat` 风险最低；`recommended_feed` 必须依赖本地 state 去重，并检查账号推荐牛人沟通权益。

`screen-and-greet` 的执行顺序固定为：

```text
recommended_feed_quota_drain
→ inbound_chat_screen_and_request
```

推荐牛人页阶段不先做 JD 评分筛选；只做 state 去重、身份绑定、可打招呼按钮确认和安全检查。聊天页阶段继续执行下面的硬条件与评分准入。

## 硬条件

聊天页候选人必须同时满足：

- 匹配当前岗位画像；优先按 `job_id` 对应的缓存画像判断，其次才用 `job_name`。
- 能提取姓名，并生成统一的 `candidate_id`；优先使用 `name+"__"+school`，学校缺失时退化为 `name`，如出现同名冲突则追加来源侧稳定标识。
- 未在状态文件中处于 `first_contact_sent`、`attachment_requested` 或之后状态。
- 未处于 `boss_completed`。
- 未明确拒绝沟通。
- 未明显不接受实习。
- 城市、到岗时间、实习周期没有明显硬冲突。
- 页面身份可校验。

不满足任一项时，不自动发送，记录跳过原因。

## 评分标准

评分必须基于岗位画像动态生成，不硬编码具体技能方向。岗位画像中的 `positive_keywords`、`negative_keywords` 和 `hard_filters` 是评分的唯一依据。

5 星（强匹配）：

- 经历与岗位画像中的 `positive_keywords` 高度吻合，有直接的项目/实习/作品证明。
- 无 `negative_keywords` 或硬冲突信号。
- 到岗时间、城市、实习/工作周期基本匹配。
- `match_reasons` 中应引用具体的岗位画像关键词，而非通用描述。

4 星（方向匹配）：

- 方向相关，有可迁移经验覆盖岗位画像中的部分 `positive_keywords`。
- 学历、学校、专业或项目背景基本符合岗位画像。
- 存在少量待确认点，但不触发 `negative_keywords` 或硬过滤。

3 星（边缘匹配）：

- 部分相关，但经历偏弱或仅覆盖少量 `positive_keywords`。
- 或到岗、城市、周期等关键信息不明确，但未触发硬过滤。

2 星（弱相关）：

- 可迁移性弱，需要人工判断。
- 触发了少量 `negative_keywords` 但不足以直接淘汰。

1 星（明显不匹配）：

- 明显不匹配岗位画像中的核心方向或触发硬过滤条件。

## 聊天页自动准入

默认准入条件：

```text
rating >= auto_send_threshold
and hard_filters_passed == true
and status not in sent_or_boss_completed_states
and greeted_count_this_run < max_greet_per_run
```

默认 `auto_send_threshold` 为 3，含义是 `rating >= 3` 即可进入打招呼池；2 星及以下不自动触达。

快速档规则：

- 默认不启用 `aggressive_prefilter_enabled`，避免为了速度静默牺牲召回。
- 用户明确选择快速档，或历史抽样证明卡片预过滤准确率足够高时，可以把详情读取上限改用 `fast_max_detail_reads_per_run`。
- 提高 `auto_send_threshold` 到 4 会改变自动触达口径，只能由用户明确指定或岗位画像明确要求，不作为默认加速手段。

`max_greet_per_run` 表示本轮聊天页求附件简历发送上限。筛选器不应为”找到第 1 个合格候选人”而提前停止；只有聊天页发送成功数达到 `max_greet_per_run`，或扫描/详情读取/列表停止条件耗尽时才结束聊天页阶段。

来源推进语义：

- `inbound_chat`：发送求附件简历消息成功后，进入 `attachment_requested`。
- `recommended_feed`：不经过本评分准入；卡片内打招呼成功后，直接进入 `attachment_requested`；Boss 侧预设打招呼语固定视为求附件简历消息。

## 岗位画像来源

- 第一优先级：本地 `job_id` 缓存画像。
- 第二优先级：当前 Boss 页面可读取的在线 JD，并在读取后写入 `job_id` 缓存。
- 第三优先级：当 `job_id` 缺失时，使用 `job_name` 默认画像并记录 `job_id_missing`。

岗位画像必须动态生成，至少包含：

- 岗位 ID 和岗位名
- 城市、到岗时间、实习/工作周期等硬过滤信息
- `positive_keywords`：加分关键词列表，如岗位核心技能、技术栈、业务方向
- `negative_keywords`：扣分关键词或硬冲突信号，如方向明显不符、城市明显不符
- `hard_filters`：必须满足的硬性条件，如最低学历、经验年限、必须掌握的技能
- `auto_send_threshold`：自动触达阈值

**生成规则**：
- 优先从在线 JD 原文中提取关键词，不要预设任何岗位类型的默认关键词。
- 如果 JD 中明确列出技术栈/技能要求，直接作为 `positive_keywords`。
- 如果 JD 中明确列出排除条件或硬性要求，直接作为 `hard_filters` 或 `negative_keywords`。
- 若 `job_name` 为默认空值或无法解析，必须暂停并要求用户明确岗位信息，不得使用硬编码的默认画像。

## 输出字段

聊天页每位候选人筛选后至少记录：

- `candidate_id`
- `name`
- `school`
  可为空；为空时应在 `risk_points` 或 `skip_reason` 中说明是否存在同名校验风险。
- `job_name`
- `source`
- `rating`
- `hard_filters_passed`
- `match_reasons`
- `risk_points`
- `skip_reason`
- `recommended_action`

## 打招呼池排序

默认排序：

1. 5 星优先。
2. 最近有新消息优先。
3. 到岗/城市更明确者优先。
4. 状态文件中更早发现但未处理者优先。

达到 `max_greet_per_run` 后，其余聊天页达标候选人标记为 `skipped_run_limit` 或保留 `eligible` 等待下轮。历史状态 `skipped_daily_limit` 只兼容读取，不再新写入。
