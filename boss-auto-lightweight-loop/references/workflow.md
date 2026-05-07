# Workflow

适用范围：本文件描述完整工作流。自动化、定时任务、无人值守、`runtime=lite` 场景必须按 `runtime-lite.md` 的 mode 必读清单读取本文件；清单外 reference 只有异常诊断、规则缺失或用户要求解释/改策略时才读取。

## 入口检查

每次运行都先执行入口检查，任一失败即暂停：

1. 检查 `web-access` CDP Proxy 可用；所有 Boss 页面动作都固定走 `web-access`。
2. 列出 Chrome targets，定位已登录 Boss 招聘者 tab。
3. 记录 Boss `targetId` 和 `browserContextId`。
4. 确认不会新开 Boss tab。
5. 做一次最小 probe：`/info` 校验 target、`/eval` 校验 `document.title`。
6. 如果本轮首次连接触发 Chrome/web-access 远程调试授权或系统确认，只允许在入口检查阶段处理一次；授权成功后缓存并复用当前 CDP Proxy、`targetId`、`browserContextId` 和探针结果，不得把授权检查放进候选人循环。
7. 如果 probe 失败或 target 已失效，先自动重绑定 Boss target；连续两次失败再暂停。
8. 确认本地目录存在：
   - `/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes`
   - `/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs`
9. 读取状态文件，若不存在则初始化空状态。
10. 若已有状态文件根节点为数组，按历史 active state 兼容读取和写回；本轮不得静默迁移为对象结构。

## screen-and-greet

使用场景：先消耗推荐牛人页沟通额度，再筛选并触达 `inbound_chat` 候选人。`screen-and-send` 已废弃为旧入口别名；收到后必须立即规范化为 `screen-and-greet`，不得维护单独流程。

步骤：

1. 确认配置或当前 Boss 上下文能得到 `job_name` 或 `job_id`；推荐页打招呼不依赖岗位画像，但写 state 仍需要岗位身份字段。
2. 不先读取在线 JD，不先生成岗位画像；固定先进入推荐牛人页额度消耗阶段。
3. 若当前 Boss tab 不在推荐牛人页，按 `browser-routing.md` 复用已登录招聘者 tab 切到推荐牛人页；不得新开普通 Boss tab。
4. 固定先处理 `recommended_feed`，不按 `candidate_sources` 把聊天页提前；`candidate_sources` 只用于开关来源和兼容输出。
5. 对 `recommended_feed` 直接读取当前已渲染候选人卡片，并用本地 state 判断本轮未处理；不要因为没有未读信号而长等待、截图或要求用户确认页面加载。
6. 推荐页执行 `recommended_feed_quota_drain`：候选人卡片按语义块做 CDP DOM 遍历，同一次 eval 中提取卡片摘要、稳定标识、按钮状态和可绑定 selector；整个读取过程默认串行，不并发发起多个浏览器读取动作。如果页面正文里能看到岗位和候选人摘要，但仍无法切分出任何候选人块，应立即停止并记录 `paused_candidate_list_not_found`。
7. 推荐页不执行 JD 评分筛选、不打开详情读在线简历；只过滤本地 state 中已触达/已完成/重复候选人、身份无法绑定候选人和没有可点击“打招呼”按钮的卡片。每个扫描候选人写最小 state，至少包含 `source="recommended_feed"`、`decision`、`skip_reason` 或 `last_observation`。
8. 推荐页按候选人卡片稳定绑定点击卡片内“打招呼”按钮；整个推荐页阶段复用入口阶段已授权的 CDP Proxy 和当前 Boss `targetId`，逐个点击当前卡片内按钮，不为每位候选人重新连接、重新授权或弹出远程调试确认。Boss 侧预设打招呼语固定视为求附件简历消息，确认成功后写入 `attachment_requested`，并记录 `decision="auto_greet_recommended_quota_drain"`、`last_observation="recommended_greet_sent_request_resume"`。
9. 推荐页相邻候选人之间等待 `recommended_greet_interval_seconds_min` 到 `recommended_greet_interval_seconds_max` 的随机间隔，默认 3-8 秒。
10. 当前屏可打招呼候选人处理完后，按 `boss-recommend-read-recipe.md` 做受控滚动或加载下一批；出现账号当日推荐牛人沟通额度耗尽、无新增可打招呼候选人、列表到底、登录/验证码/弹窗阻断、候选人身份无法唯一绑定或连续点击无状态变化时，结束推荐页阶段。额度耗尽写 `paused_boss_contact_quota_exhausted`，但允许本轮继续进入聊天页筛选发送；登录、验证码、身份不匹配等安全暂停仍立即停止整轮。
11. 推荐页阶段结束后，复用当前 Boss tab 解析当前岗位 `job_id`；优先使用配置覆盖的 `job_id`，其次从 Boss 职位 URL/聊天上下文解析，最后才退化为 `job_name`。
12. 按 `job_id` 加载岗位画像缓存；缓存命中且未过期时直接复用筛选画像，不再读取完整在线 JD。若外部脚本已预热 `job_profile_cache_dir` 且缓存未过期，直接使用预热画像；缓存缺失、过期或用户显式变更岗位配置时，才读取在线岗位和 JD，生成岗位画像并写入本地缓存。若有多个岗位，按配置 `job_id` 优先匹配，其次按 `job_name` 匹配，并基于岗位画像和 `screening-policy.md` 生成或复用默认筛选标准。
13. 再处理 `inbound_chat`，先执行 `discover_unread_targets`：识别相关标签页中的本轮未读候选人集合，合并形成 `unread_target_set`；不要一边找人一边直接读简历。
14. 对聊天页执行 `incremental_list_read`：候选人列表按语义块做 CDP DOM 遍历，并结合滚动完整性做增量读取；同一次 eval 中提取卡片摘要、未读信号、稳定标识或临时 `data-*` 标记。
15. 执行聊天页 `card_prefilter`：用卡片工作/教育摘要、岗位、城市、最近摘要和 state 去重生成 `detail_read_queue` 与 `card_skip_set`；明显硬过滤不通过的候选人直接写最小 state，只有可能达标或信息不足的候选人才进入详情读取队列。
16. 对聊天页 `detail_read_queue` 中的候选人逐个执行详情读取：用 `thread_panel_link` 左右联动，先确认详情属于同一候选人。本轮最多打开 `max_detail_reads_per_run` 个详情；若 `aggressive_prefilter_enabled=true`，可使用 `fast_max_detail_reads_per_run`。如果中途出现 stale target 或 page identity 失效，先重绑定 Boss target，再从当前候选人的阶段恢复。
17. 再执行聊天页 `resume_panel_read`：只在身份一致、且命中 `在线简历/附件简历` 锚点后的详情容器时，提取姓名、学校、教育、工作/项目摘要和最近真实消息气泡；不要改走 `opencli boss resume/chatmsg` 适配器。
18. 提取 `name`，若能拿到 `school` 则一并保留；生成统一的 `candidate_id`，优先 `name+"__"+school`，缺学校时退化为 `name`，若同名冲突则追加来源侧稳定标识。
19. 如果卡片可见工作经历或教育经历摘要，保存 `card_work_experience_text` 与 `card_education_experience_text`。这些原始摘要只用于 Boss 侧大模型打分和人工复核，不在 Boss 侧继续维护 `career_list`、`education_list`。
20. 若需要读取最近消息，只允许读取真实聊天消息气泡；底部快捷话术、输入框占位词、`求简历`/`换电话`/`换微信`/`约面试` 等动作栏文本必须排除，不能作为拒绝信号或历史对话。
21. 如果聊天页右侧打开后只能提取到聊天输入框和快捷动作栏，而拿不到在线简历正文、姓名或教育字段，应立即停止并记录 `paused_resume_panel_not_found`，不要继续扫描后续候选人。
22. 依据岗位画像和 `screening-policy.md` 打分，并为每个聊天页扫描候选人写入最小筛选状态：至少包含 `source`、`rating`、`hard_filters_passed`、`decision`、`skip_reason`。
23. 仅将满足自动准入规则的聊天页候选人加入 `auto_contact_pool`。
24. `inbound_chat` 使用固定模板发送求附件简历消息：同一聊天页相邻候选人可按 `thread_fast_switch_enabled` 复用左侧列表和右侧面板结构，快速点击下一张卡片切换；切换后仍必须做身份校验。写入输入框后立即校验文本，最多等待 `input_to_send_delay_ms` 后点击发送。
25. 聊天页发送后在 `send_confirm_timeout_ms` 内只做短时确认并将状态推进到 `attachment_requested`；若本轮已发送，则清空 `skip_reason`。不得长等“已读/送达”。聊天页达到 `max_greet_per_run` 后停止发送并汇报；`max_greet_per_run` 不再截断推荐牛人页额度消耗。
26. 每处理 `health_check_every_candidates` 位候选人做一次轻量页面健康检查，只确认 target、Boss 上下文、登录/验证码显性信号和页面可控状态；不要每位候选人都做大诊断。
27. 状态写入采用批量化 flush 策略：候选人级状态变更先缓存在内存中，每累积 `state_flush_batch_size` 位候选人或遇到 `paused_*` 暂停态、失败态、本轮结束时统一写入本地 state 文件一次；运行日志仍按事件即时追加 JSONL，不因状态批量化而延迟。
28. 本轮结束前做轻量反向核对：发现的未读/未处理候选人数、已成功更新人数、仍未更新人数及原因。
29. 联系方式、证件号、全量教育和全量工作经历的解析统一交给下游 `feishu-hire-sync`，Boss 侧不维护这些结构化字段。

## 岗位画像缓存

- 缓存键优先为 `job_id`。同名岗位可能对应不同 JD，不能只用 `job_name` 覆盖缓存。
- 缓存文件默认位于 `/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/job-profiles`。
- 缓存字段包括：`job_id`、`job_name`、`source_url`、`city`、`internship_period`、`arrival_requirement`、`hard_filters`、`positive_keywords`、`negative_keywords`、`auto_send_threshold`、`jd_summary`、`created_at`、`updated_at`。
- 缓存命中后，本轮筛选必须直接使用缓存画像；不要为了“更完整”重复读取在线 JD。
- 如果解析不到 `job_id`，允许退化到 `job_name` 缓存，但运行日志必须记录 `job_id_missing`。

## collect-resumes

使用场景：只检查已经发过求简历消息的候选人。

候选人范围只能来自状态文件中的下列状态：

- `attachment_requested`
- `attachment_sent_by_candidate`
- `attachment_received`
- `resume_downloaded`
- `download_failed`
- `sync_queue_failed`

本轮最多处理 `max_collect_per_run` 位候选人。达到上限后停止本轮，保留剩余候选人的当前状态，下次从 `collect-resumes` 继续。

步骤：

1. 获取运行锁后，先按 `browser-routing.md` 的下载路径控制规则，通过 web-access CDP 将 Chrome 下载目录设置为 `resume_download_dir`；只设置一次，失败则记录 `last_observation="download_dir_set_failed"`、必要时记录 `last_error="download_dir_cdp_failed"`，并回退默认下载目录 + 移动/重命名流程。
2. 逐个打开状态文件中的目标候选人线程。
3. 校验候选人 `name + job_name`，学校存在时作为增强匹配信号，避免错收错发。
4. 检查是否存在附件请求卡片。
5. 如果出现“同意/接收”，使用 `web-access clickAt` 点击；若当前候选人线程内有 2 个可点击的“同意/接收”，选择消息流中第一个附件请求卡片按钮。
6. 如果出现附件卡片，点击“点击预览附件简历”。
7. 在预览层只在外层预览壳右上角点击“下载”文本或按钮，不要找 PDF 直链、签名 URL 或 iframe 内部路径。
8. 等待本地下载文件出现：按 `download_poll_interval_ms` 轮询，最多等待 `download_max_wait_seconds`；只接受点击下载后新出现或 `mtime` 更新、非 `.crdownload/.tmp`、且文件大小连续 2 次轮询稳定的文件。
9. 若已成功设置下载目录，直接在 `resume_download_dir` 内重命名为规范文件名；若未成功设置下载目录，则从默认下载目录移动到 `resume_download_dir` 后再重命名。
10. 计算 `resume_hash`，本地文件校验成功后标记 `resume_downloaded` 并立即 flush。
11. 退出附件预览界面，短确认回到当前候选人的聊天线程。
12. 若上一轮已经点过“同意/接收”但尚未完成下载，直接从 `attachment_received` 继续预览和下载，不要回退到等待附件。
13. 若本轮下载已经完成但上一轮在写队列前中断，直接从 `resume_downloaded` 继续，不要重新索取或重新下载。
14. 写入 `sync_queue_file`。必需字段只记录 `candidate_id`、`name`、`school`、`filename`、`local_resume_path`、`resume_hash`、`boss_status`、`sync_queue_status`；可选审计字段只记录 `job_name`、`card_work_experience_text`、`card_education_experience_text`。不要写 `resume_source_id`、`match_reasons`、`risk_points`、结构化经历、联系方式或证件号；飞书来源 ID 和复杂简历解析由下游 `feishu-hire-sync` 处理。
15. 队列 JSONL 追加成功后标记 `ready_for_hire_sync` 并立即 flush，避免队列与 state 不一致。
16. 回复候选人：`简历已收到，我们会尽快筛选，合适的话会联系您。`
17. 回复短确认成功后写 `boss_completed`；采用批量化 flush 时，该状态变更在批次统一写入时落盘。如果回复失败但队列已写成功，保持 `ready_for_hire_sync` 并暂停为 `paused_send_failed`，下次只补回复。
18. 每处理 `health_check_every_candidates` 位候选人做一次轻量页面健康检查；只有失败时才进入大诊断或暂停。
19. `collect-resumes` 也使用 `state_flush_batch_size` 批量 flush；但 `resume_downloaded`、`ready_for_hire_sync` 和任何失败/暂停态必须立即 flush，避免本地文件、同步队列和 state 不一致。

兼容要求：

- 历史 state 若仍含有 `attachment_receive_pending`，本轮应视为 `attachment_requested` 继续处理，但后续只写统一状态 `attachment_requested`。

## follow-greeted

使用场景：兼容历史状态，只跟进旧数据中已打招呼但尚未发送求附件简历消息的候选人。新推荐牛人页流程打招呼成功后直接进入 `attachment_requested`，不再进入本模式。

候选人范围只能来自状态文件中的 `first_contact_sent`。

步骤：

1. 在聊天列表中按 `candidate_id`、姓名、岗位和学校辅助信号查找候选人是否已形成会话或有新回复。
2. 若无法稳定定位聊天线程，保持 `first_contact_sent`，记录 `last_observation="waiting_for_chat_thread"`。
3. 若已形成聊天线程，按聊天页发送路径校验身份。
4. 发送 `request_resume_message` 并在短时确认成功后推进到 `attachment_requested`。
5. 本模式不读取推荐牛人页新候选人，不接收附件，不下载简历。

## full-cycle

使用场景：小批量端到端试运行。

执行顺序：

```text
screen-and-greet
→ collect-resumes
```

注意：候选人发附件是异步行为，`full-cycle` 不保证同轮全部完成。推荐牛人页打招呼成功后保持 `attachment_requested`，下次用 `collect-resumes` 继续；历史 `first_contact_sent` 候选人仍可用 `follow-greeted` 兼容推进。

## dry-run

使用场景：验证筛选标准和自动准入，不做外部动作。

禁止动作：

- 不发送 Boss 消息。
- 不点击同意/接收。
- 不下载附件。
- 不写本地待同步队列。
- 不修改 Boss 侧状态文件以外的内容。

允许动作：

- 读取 JD。
- 读取候选人。
- 自动打分。
- 生成候选人池。
- 写入本地 dry-run 运行日志。

## 异常即停

出现以下情况立即停止本轮：

- Boss 验证码或异常验证。
- Boss 登录态失效。
- 页面跳到非招聘者上下文。
- 当前线程身份和目标候选人不一致。
- 连续 3 次发送失败。
- 附件接收点击失败。
- Chrome 下载失败。
- 本地待同步队列写入失败。

停止后输出：

- 停止步骤。
- 已完成候选人。
- 未完成候选人。
- 当前状态文件路径。
- 下次建议运行模式，以及是否已经进入飞书招聘同步队列。
