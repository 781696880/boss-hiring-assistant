---
name: feishu-hire-sync
description: 将本地已下载的 Boss 简历同步到飞书招聘 ATS：上传附件、创建或复用人才、创建投递、可选加入人才库和写备注。适合先作为独立测试 skill 跑通，再并回 boss-auto-lightweight-loop。
---

# Feishu Hire Sync

## 定位

这个 skill 只负责 **Feishu Hire 同步**，不负责 Boss 筛选、打招呼或收附件。

默认前置条件：

- 本地简历已经落盘
- Boss 队列里的候选人已进入 `resume_downloaded`、`ready_for_hire_sync` 或 `boss_completed`
- 有目标 `job_id`
- 有 `resume_source_id`
- 下游同步阶段负责直接从本地 PDF 解析 `mobile`、`email`、`identification`、`education_list`、`career_list`、`project_list`、`self_evaluation`、`resume_structured` 等简历内容；Boss 侧不要求这些字段先存在

如果缺少 `job_id` 或 `resume_source_id`，先暂停，不要同步。
`resume_source_id` 必须是飞书招聘接口接受的数字字符串，例如当前 `.env.local` 中的 `FEISHU_HIRE_RESUME_SOURCE_ID=18`。如果 Boss manifest/queue 里带了非数字来源标识（例如 `boss_zhipin`），wrapper 必须在调用上传器前用 `.env.local` 的 `FEISHU_HIRE_RESUME_SOURCE_ID` 清洗覆盖，不允许把非数字值传给飞书接口。
如果本地解析后仍缺少任何可用于去重的真实标识，先标记 `needs_manual_review`，不要用虚拟手机号或邮箱补齐。

## 默认执行方式

优先使用本 skill 内的脚本包装层：

- `scripts/sync-to-feishu.mjs`

它会调用现有的飞书招聘同步实现，并把本次运行限定在 ATS 同步范围内。

## 配置入口

这个测试 skill 只负责流程约束，不把密钥写进 skill 文件。

请在下面三个位置改配置：

1. **飞书应用凭证**
   - 文件：`/Users/apple/ai-worker/feishu-hire-uploader/.env.local`
   - 字段：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`

2. **ATS 同步目标**
   - 文件：`/Users/apple/ai-worker/feishu-hire-uploader/.env.local`
   - 字段：`FEISHU_HIRE_JOB_ID`、`FEISHU_HIRE_RESUME_SOURCE_ID`、`FEISHU_HIRE_TALENT_POOL_ID`

3. **本地候选人快照**
   - 文件：`/Users/apple/ai-worker/feishu-hire-uploader/.env.local`
   - 字段：`FEISHU_HIRE_CANDIDATE_MANIFEST`
   - 默认值：`/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto-lightweight-loop-state.json`
   - 作用：直接消费 Boss 输出的本地 state 或兼容 JSON/JSONL manifest。Boss 侧最小字段只需要 `candidate_id`、`name`、`school`、`filename`、`local_resume_path`、`resume_hash`、`boss_status/status`；`job_name`、`card_work_experience_text`、`card_education_experience_text` 仅作为可选审计字段。
   - 示例：`/Users/apple/ai-worker/feishu-hire-uploader/feishu-candidates.example.jsonl`
   - skill wrapper 默认不会继承 shell 里遗留的旧 `FEISHU_HIRE_CANDIDATE_MANIFEST`；如需覆盖，请显式设置 `FEISHU_HIRE_SYNC_MANIFEST`

4. **本地同步状态**
   - 默认文件：`/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/feishu-hire-sync-state.json`
   - 可通过 `FEISHU_HIRE_SYNC_STATE_FILE` 或 `FEISHU_HIRE_SYNC_STATE` 覆盖
   - skill wrapper 默认不会继承 shell 里遗留的旧 `FEISHU_HIRE_UPLOAD_STATE`

5. **本地简历目录**
   - 默认目录：`/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes`
   - wrapper 会优先把这个目录显式传给 uploader，避免继承旧环境里的 `RESUME_DIR=/Users/apple/Downloads/boss-resumes`
   - 如需覆盖，请显式设置 `FEISHU_HIRE_SYNC_RESUME_DIR` 或 `FEISHU_HIRE_RESUME_DIR`

## 字段契约

- Boss fresh state 里的 `candidate_id`、`local_resume_path`、`resume_hash`、`boss_status/status` 是本地映射层字段；`external_id`、`candidate_uid` 可缺省，下游默认复用 `candidate_id`。
- Boss 侧传来的 `card_work_experience_text`、`card_education_experience_text` 仅作为审计和人工复核上下文，不直接写入飞书招聘经历字段。
- ATS 查重和复用人才依赖本地 PDF 解析后的 `mobile`、`email`、`identification`，这些字段优先级高于 Boss 卡片摘要字段。
- ATS 人才创建/更新使用飞书 `combined_create` / `combined_update` 官方字段：`basic_info`、`education_list`、`career_list`、`project_list`、`self_evaluation`。其中 `identification.identification_type` 使用数字枚举，例如中国居民身份证为 `1`。
- 本地状态额外记录参考 `openclaw/skills` `resume-parser` 的统一结构化快照 `resume_structured`：`basic_info`、`education`、`work_experience`、`projects`、`skills`、`certificates`、`awards`、`self_assessment`。该快照只用于审计/后续映射，不把飞书不支持的字段直接传入 ATS API。
- 本地 PDF 解析必须优先使用 PyMuPDF 行级坐标信息重建阅读顺序，再做分段和字段抽取；不要只依赖 `get_text("text")` 的纯文本顺序。教育/工作写入前必须过滤低置信记录，例如奖学金、GPA/课程、在校职务、荣誉证书、项目奖项、结束时间早于开始时间的经历。
- `resume_downloaded` 是允许进入飞书同步的起点状态，不需要先把 Boss 状态改写成 `ready_for_hire_sync`。
- Boss 侧 manifest 不要求提供 `education_list` / `career_list`；教育和工作经历优先由本 skill 在本地 PDF 解析链路内完成。若 manifest 已有可信结构化列表，仅在本地解析为空时作为兜底。
- Boss 侧 manifest 不再需要提供 `resume_source_id`；若历史记录中存在且缺失或非数字，使用 `.env.local` 中的 `FEISHU_HIRE_RESUME_SOURCE_ID` 作为唯一准入来源 ID。

## 典型流程

1. 读取 Boss 同步队列 manifest 和本地 uploader state。
2. 只处理 manifest 中 `boss_status` 或 `status` 为 `resume_downloaded`、`ready_for_hire_sync` 或 `boss_completed` 的候选人；`contact_resolution_status=needs_manual_review` 的记录先暂停，不强行创建虚拟联系方式。
3. 上传本地简历到飞书招聘附件。
4. 自动解析本地 PDF 文本里的手机号、邮箱、身份证、教育背景、工作经历、项目经历、技能、证书、奖项和自我评价，必要时再合并 manifest 信息。
5. 用真实手机号、邮箱或证件号查重人才。
6. 创建或复用人才。
7. 创建职位投递。
8. 可选加入人才库。
9. 可选写备注。
10. 回写本地状态、`talent_id`、`application_id` 和错误信息。

## 参考文件

- `references/workflow.md`：执行顺序和重试边界
- `references/state-machine.md`：状态机和本地状态结构

## 运行约束

- 不要重复处理已经有 `talent_id` 且 `application_id` 的候选人。
- 不要在这个 skill 里做 Boss 页面操作。
- 不要把归档飞书文档或云盘当作同步成功的标准。
- 任何同步失败都要落到本地状态，便于下一轮重试。
- `candidate_id` 是 Boss 到 Feishu 的主映射键，`external_id` 由下游默认与 `candidate_id` 保持一致。
