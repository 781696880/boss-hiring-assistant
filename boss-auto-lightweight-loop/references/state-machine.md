# State Machine

## 候选人状态

主路径：

```text
discovered
→ screened
→ eligible
→ attachment_requested
→ attachment_sent_by_candidate
→ attachment_received
→ resume_downloaded
→ ready_for_hire_sync
→ boss_completed
```

跳过态：

```text
skipped_low_score
skipped_hard_filter
skipped_duplicate
skipped_run_limit
skipped_already_boss_completed
skipped_identity_incomplete
```

暂停态：

```text
paused_login_required
paused_captcha_detected
paused_candidate_identity_mismatch
paused_candidate_list_not_found
paused_thread_switch_failed
paused_resume_panel_not_found
paused_send_confirm_timeout
paused_send_failed
paused_boss_contact_quota_exhausted
paused_attachment_accept_failed
paused_download_failed
paused_sync_queue_write_failed
```

可恢复失败态：

```text
download_failed
sync_queue_failed
```

历史兼容态：

```text
first_contact_sent
skipped_daily_limit
```

`first_contact_sent` 只用于兼容旧数据，不再属于新推荐牛人页主路径。
`skipped_daily_limit` 只作为旧状态兼容读取；新写入统一使用 `skipped_run_limit`。

`paused_boss_contact_quota_exhausted` 是推荐牛人页阶段停止原因。它表示推荐页当日沟通权益耗尽，不等同于整轮 `screen-and-greet` 失败；若没有登录、验证码、身份错配或页面不可控等安全暂停，本轮仍可继续进入聊天页筛选发送。

## 状态文件位置

默认：

```text
/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto-lightweight-loop-state.json
```

## JSON 结构

新建状态文件时使用对象结构；读取已有状态时必须兼容历史数组结构。

兼容规则：

- 如果 state 根节点是数组，视为 active candidates 列表；按 `candidate_id` 更新数组中对应候选人，新增候选人追加到数组尾部。
- 如果 state 根节点是对象且包含 `candidates`，按 `candidates[candidate_id]` 更新。
- 同一轮写回必须保留原始根结构，不得在自动运行中把数组静默迁移为对象，避免破坏现有脚本或人工复盘。
- 缺失 `status` 的历史候选人视为 `screened` 或按 `decision/skip_reason` 投影为跳过态，但写回时应补齐最小 `status`。

```json
{
  "version": 1,
  "updated_at": "2026-04-21T10:30:00+08:00",
  "config": {
    "job_name": "Python",
    "auto_send_threshold": 3,
    "max_greet_per_run": 5,
    "recommended_feed_quota_drain_first": true,
    "recommended_greet_interval_seconds_min": 3,
    "recommended_greet_interval_seconds_max": 8,
    "max_collect_per_run": 10,
    "max_scan_per_run": 30,
    "max_detail_reads_per_run": 12,
    "max_list_scroll_rounds": 4,
    "candidate_sources": ["recommended_feed", "inbound_chat"],
    "candidate_id_strategy": "name_plus_school_or_name",
    "resume_download_dir": "/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes",
    "sync_queue_file": "/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto-lightweight-loop-sync-queue.jsonl"
  },
  "candidates": {
    "张三__南京大学": {
      "candidate_id": "张三__南京大学",
      "name": "候选人姓名",
      "school": "南京大学",
      "job_name": "Python",
      "source": "inbound_chat|recommended_feed",
      "status": "screened",
      "rating": 4,
      "hard_filters_passed": true,
      "decision": "skip",
      "skip_reason": "already_contacted",
      "card_work_experience_text": "2025.11-2026.04 科大讯飞 · Python",
      "card_education_experience_text": "2022-2026 大连交通大学 · 数据科学与大数据技术 · 本科",
      "last_message": null,
      "message_sent_at": "2026-04-21T10:35:00+08:00",
      "greeted_at": null,
      "local_resume_path": null,
      "resume_hash": null,
      "resume_downloaded_at": null,
      "ready_for_hire_sync_at": null,
      "boss_completed_at": null,
      "sync_queue_status": "pending",
      "boss_status": null,
      "last_observation": "message_sent",
      "last_error": null,
      "history": [
        {
          "at": "2026-04-21T10:35:00+08:00",
          "action": "send_resume_request",
          "result": "ok"
        }
      ]
    }
  }
}
```

## 更新规则

- 每个候选人用 `candidate_id` 去重。
- `candidate_id` 优先由标准化后的 `name + "__" + school` 生成；若 `school` 缺失则退化为 `name`，如出现同名冲突则追加来源侧稳定标识。
- 新写入的 Boss active state 和 sync queue 不再需要 `external_id`；下游飞书同步默认用 `candidate_id` 派生稳定映射键。历史 state 中已有 `external_id` 时兼容读取即可。
- 筛选阶段读到的卡片级工作/教育摘要应分别保存到 `card_work_experience_text`、`card_education_experience_text`。
- 写入飞书同步队列时，Boss 侧必需字段只保留 `candidate_id`、`name`、`school`、`filename`、`local_resume_path`、`resume_hash`、`boss_status`、`sync_queue_status`；`job_name`、`card_work_experience_text`、`card_education_experience_text` 是可选审计字段。
- 聊天页筛选阶段得到的 `rating`、`hard_filters_passed`、`decision`、`skip_reason` 必须写入 state，即使候选人没有进入打招呼池也要保留最小筛选摘要。推荐牛人页额度消耗阶段不做 JD 评分筛选，可将 `rating`、`hard_filters_passed` 留空，但必须写入 `source="recommended_feed"`、`decision`、`skip_reason` 或 `last_observation`。
- 自动化运行中候选人状态变更优先缓存在内存，每累积 `state_flush_batch_size` 位候选人或遇到 `paused_*` 暂停态、发送失败、下载失败、队列写入失败、下载完成、队列写入成功、本轮结束时统一 flush 到本地 state 文件；运行日志仍按事件即时追加 JSONL。轻量字段更新包括 `status`、对应 `*_at` 时间、`last_observation`、`last_error`、`sync_queue_status`、`local_resume_path`、`resume_hash` 和一条精简 `history`。不要为了复盘重写长文本字段。
- 聊天页自动发送准入阈值为 `rating >= 3`，配置上保持 `auto_send_threshold=3`；3 星候选人在硬条件通过时也可自动索要简历。推荐牛人页额度消耗阶段不使用该评分阈值。
- 配置中的处理上限统一为：`max_greet_per_run` 控制推荐页结束后的聊天页求附件简历发送成功数，`max_collect_per_run` 控制 `collect-resumes` 附件回收候选人数，`max_scan_per_run` 控制候选人卡片扫描数，`max_detail_reads_per_run` 控制聊天页详情读取数，`max_list_scroll_rounds` 控制列表滚动轮数；新流程不得再写入或依赖 `daily_target`、`max_send_per_run`。推荐牛人页阶段不受 `max_greet_per_run` 截断，停止边界是平台沟通额度、列表到底、无新增可打招呼候选人、本地 state 去重和安全暂停。
- `screen-and-greet` 是先推荐页、后聊天页的触达入口：`recommended_feed` 点击打招呼按钮成功后进入 `attachment_requested`，因为 Boss 侧预设打招呼语固定视为求附件简历消息；推荐页阶段结束后，`inbound_chat` 发送求附件简历消息成功也进入 `attachment_requested`。
- `first_contact_sent` 仅作为历史兼容状态保留；新推荐牛人页流程不得再写入该状态。
- 如果页面正文里已能看到岗位文本和候选人摘要，但仍无法切分出任何候选人块，应立即进入 `paused_candidate_list_not_found`，不得继续做空扫描。
- `paused_candidate_list_not_found` 的语义是“读取链路没能稳定切分候选人块”，不是“当前页面没有候选人”。
- `last_message` 只允许记录真实聊天消息气泡；如果页面只能拿到整页文本或混入快捷话术区，必须写 `null`，不能把底部快捷话术当作历史消息。
- 如果右侧线程已打开但提取结果同时满足 `resumeText=""`、`last_message=null/messages=[]` 且只检测到快捷动作按钮，应立即进入 `paused_resume_panel_not_found`，不得继续扫描后续候选人。
- `paused_resume_panel_not_found` 的语义是“右侧联动后没有稳定命中在线简历详情区域”，不是“候选人没有简历”。
- Boss 侧 state 和 sync queue 不再维护 `career_list`、`education_list` 等结构化经历字段。
- Boss 侧交接契约只覆盖原始卡片摘要、本地 PDF 路径和最小身份字段；`resume_source_id`、联系方式、证件号、全量教育经历、全量工作经历解析统一交给下游 `feishu-hire-sync`。
- `match_reasons`、`risk_points`、`message_text` 等长筛选/话术字段不写入飞书同步队列；需要复盘时从运行日志或 archive 读取。
- 如果筛选阶段拿不到学校字段，允许继续进入筛选与自动触达流程，但需在 `risk_points` 或 `last_observation` 中记录 `school_missing`，并在同名候选人场景追加身份校验。
- `download_dir_set_failed` 是允许的 `last_observation`：表示 CDP 设置 Chrome 下载目录失败，已回退到默认下载目录 + 移动/重命名流程；这不是暂停态，不应停止本轮。
- 若需要记录具体错误，使用 `last_error="download_dir_cdp_failed"`，并在 JSONL 事件中记录底层错误摘要。
- 状态只能向前推进，除非进入可恢复失败态。
- `state-machine.md` 是暂停态常量的唯一真理来源；其他 recipe 或 service 文档不得再引入未注册的 `paused_*` 新名字。
- `paused_send_confirm_timeout` 只表示发送点击后未在短超时内确认输入框清空、目标线程最后一条真实消息短摘要或当前卡片状态变化；不得为了等待“已读/送达”延长确认。恢复时必须先重新校验线程和最后一条真实消息，避免重复发送。
- 历史 state 若仍存在 `attachment_receive_pending`，下一轮读取时按 `attachment_requested` 兼容处理，不再写回该旧状态。
- 不允许重复打招呼给 `first_contact_sent` 及以后状态的候选人；不允许重复发送求简历消息给 `attachment_requested` 及以后状态的候选人。
- 不允许重复下载已经有 `resume_hash` 的同一本地文件。
- 每个状态变化都写入一条精简 `history`；自动化运行不在 `history` 中保存完整页面文本、完整消息正文或长筛选解释。

## 快速推进点

- 发送求附件简历或推荐牛人页打招呼短确认成功后，标记 `attachment_requested`；采用批量化 flush 时，该状态在批次统一写入时落盘，JSONL 事件必须即时追加。
- 附件下载成功并完成本地文件校验/hash 后，标记 `resume_downloaded` 并立即 flush，避免崩溃后重复下载。
- 待同步队列 JSONL 写入成功后，标记 `ready_for_hire_sync` 并立即 flush，避免下游队列与 state 不一致。
- 候选人确认回复短确认成功后，标记 `boss_completed` 和 `boss_completed_at`；可随批次 flush，但本轮结束前必须落盘。
- 若确认回复失败但队列已写成功，保留 `ready_for_hire_sync`，记录 `paused_send_failed`，下次只补 Boss 侧确认回复，不重复下载或重复写队列。

## 可重跑策略

- `first_contact_sent`：历史兼容状态，只表示已触达但尚未确认求附件简历消息已发送；下次 `follow-greeted` 或 `screen-and-greet` 在聊天界面确认候选人会话/回复后，再发送求附件简历消息并推进到 `attachment_requested`。
- `attachment_requested`：下次 `collect-resumes` 继续检查附件。
- `attachment_received`：下次从附件预览和下载开始，不得回退到等待附件。
- `download_failed`：下次从附件卡片预览和下载开始。
- `resume_downloaded`：下次从本地文件校验和写队列开始，跳过下载，不在 Boss 侧继续做复杂简历解析。
- `ready_for_hire_sync`：下游飞书招聘同步 skill 可直接消费。
- `sync_queue_failed`：下次重新写入本地待同步队列。
- `boss_completed`：Boss 侧动作已结束，飞书同步侧仍可继续消费。

## boss_completed 语义

`boss_completed` 只表示 Boss 侧触达、收件、下载、本地落盘和队列写入已经完成，不代表飞书招聘同步完成。
飞书招聘入库、人才创建、投递创建由独立同步 skill 继续处理。
