# State Machine

## Candidate states

```text
discovered
→ screened
→ attachment_requested
→ attachment_sent_by_candidate
→ attachment_received
→ resume_downloaded
→ ready_for_hire_sync
→ feishu_attachment_uploaded
→ feishu_talent_created_or_reused
→ feishu_application_created
→ feishu_pool_added_optional
→ feishu_note_added_optional
→ completed
```

## Manual review states

```text
needs_manual_review
paused_missing_job_id
paused_missing_resume_source_id
paused_missing_unique_identity
paused_feishu_auth_required
paused_feishu_upload_failed
paused_feishu_talent_failed
paused_feishu_application_failed
```

## Local state shape

```json
{
  "version": 1,
  "updated_at": "2026-04-23T10:30:00+08:00",
  "config": {
    "resume_download_dir": "/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes",
    "state_file": "/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/feishu-hire-sync-state.json",
    "manifest_file": "/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto-lightweight-loop-state.json",
    "sync_mode": "talent_application",
    "job_id": "",
    "resume_source_id": "18",
    "talent_pool_id": ""
  },
  "candidates": {
    "张三__南京大学": {
      "candidate_id": "张三__南京大学",
      "name": "候选人姓名",
      "school": "南京大学",
      "job_key": "AI应用实习生",
      "source": "boss",
      "boss_status": "resume_downloaded",
      "status": "resume_downloaded",
      "card_work_experience_text": "2025.11-2026.04 科大讯飞 · Python",
      "card_education_experience_text": "2022-2026 南京大学 · 计算机科学与技术 · 本科",
      "resume_hash": "sha256...",
      "local_resume_path": "/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes/xxx.pdf",
      "contact": {
        "mobile": "",
        "mobile_country_code": "CN_1",
        "email": "",
        "identification_type": 1,
        "identification_number": ""
      },
      "education_list": [],
      "career_list": [],
      "project_list": [],
      "self_evaluation": null,
      "feishu": {
        "attachment_id": "",
        "talent_id": "",
        "application_id": "",
        "talent_pool_id": "",
        "note_id": ""
      },
      "sync_status": "pending",
      "last_error": "",
      "history": []
    }
  }
}
```

## Transition rule

- `resume_downloaded` is already eligible for ATS sync when the local file exists and the candidate snapshot contains at least resume path plus candidate identity.
- Boss queue candidates with `boss_status` or `status` in `resume_downloaded`, `ready_for_hire_sync`, or `boss_completed` are eligible for ATS sync.
- Boss queue payloads are expected to carry raw summaries plus the local PDF path; contact extraction and structured resume parsing happen inside this downstream skill.
- Boss manifest does not need to carry `external_id` or `resume_source_id`. The wrapper derives `external_id` from `candidate_id` and injects numeric `resume_source_id` from `FEISHU_HIRE_RESUME_SOURCE_ID` in `.env.local`; if no numeric fallback exists, pause before API calls.
- `completed` means the Feishu side has already been written successfully.
- If any sync step fails after attachment upload, keep the created Feishu IDs in state so the next run can resume without duplicating work.
