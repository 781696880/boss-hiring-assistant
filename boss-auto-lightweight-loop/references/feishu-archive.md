# Feishu Hire Handoff

本 reference 仅描述 Boss 侧如何为独立的飞书招聘同步 skill 生成稳定交接数据。
Boss 侧不再执行飞书云盘上传或飞书文档写入，只保留同步飞书招聘系统所需的本地交接数据。

## 交接内容

Boss 侧收件完成后，只需要保证本地交接信息完整：

- 候选人姓名
- 候选人学校
- `candidate_id`
- 简历文件名
- 本地简历路径
- `resume_hash`
- `boss_status`
- 本地待同步队列写入结果

可选审计字段：

- 岗位名
- 原始卡片工作经历摘要 `card_work_experience_text`
- 原始卡片教育经历摘要 `card_education_experience_text`
- `ready_for_hire_sync` 时间

## 交接原则

- Boss 侧只负责本地可恢复动作，不直接依赖飞书招聘 API。
- 交接数据要可幂等重放，重复运行不得生成重复的本地候选人记录。
- Boss 侧只交接原始卡片摘要、本地 PDF 路径和最小身份字段，不再维护 `career_list`、`education_list` 等结构化经历字段。
- `external_id` 由下游默认复用 `candidate_id`，Boss 侧不必写。
- `resume_source_id` 由下游 `feishu-hire-sync` 从 `.env.local` 的 `FEISHU_HIRE_RESUME_SOURCE_ID` 注入，Boss 侧不写。
- 联系方式提取、证件号识别、全量教育经历解析、全量工作经历解析都由下游 `feishu-hire-sync` 直接基于本地 PDF 完成。
- 真实的 `talent_id`、`application_id`、`resume_attachment_id` 由独立飞书招聘同步 skill 生成。
- 如果同步 skill 失败，Boss 侧不回滚收件结果，只保留本地状态和下载文件。

## 推荐队列记录模板

```json
{
  "candidate_id": "张三__南京大学",
  "name": "张三",
  "school": "南京大学",
  "job_name": "Python",
  "filename": "Python_张三_南京大学_20260421.pdf",
  "card_work_experience_text": "2025.11-2026.04 科大讯飞 · Python",
  "card_education_experience_text": "2022-2026 大连交通大学 · 数据科学与大数据技术 · 本科",
  "local_resume_path": "/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes/xxx.pdf",
  "resume_hash": "xxx",
  "sync_queue_status": "pending",
  "boss_status": "boss_completed",
  "ready_for_hire_sync_at": "2026-04-21T10:30:00+08:00"
}
```
