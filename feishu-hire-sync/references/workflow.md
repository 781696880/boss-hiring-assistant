# Workflow

## Scope

This skill synchronizes local Boss resumes into Feishu Hire.
It does not screen candidates, send chat messages, or receive attachments.

## Order

1. Load config, uploader state, and the Boss queue manifest.
2. Select only candidates whose manifest record has `boss_status` or `status` in `resume_downloaded`, `ready_for_hire_sync`, or `boss_completed`.
3. Enrich downstream-only fields before calling Feishu: derive `external_id` from `candidate_id` when absent, and set `resume_source_id` from `FEISHU_HIRE_RESUME_SOURCE_ID` in `.env.local`.
4. Skip any candidate that already has both `talent_id` and `application_id`.
5. Upload the local resume to Feishu attachments.
6. Parse the local PDF and merge extracted `mobile`, `email`, `identification`, `education_list`, `career_list`, `project_list`, and `self_evaluation` into the candidate meta.
7. Find an existing talent by mobile, email, or identification.
8. Create or reuse the talent.
9. Create the job application with `job_id`.
10. Optionally move the talent into a talent pool.
11. Optionally create a note.
12. Persist `attachment_id`, `talent_id`, `application_id`, status, and error details.

## Identity rules

- Use `candidate_id` as the durable local key.
- Match manifest records by `resume_hash`, `local_resume_path`, filename, or inferred candidate name in that order.
- Prefer real `mobile`, `email`, or `identification` for Feishu de-duplication, using fields extracted from the local resume when available.
- When a manifest is present, prefer `candidate_id` as the stable mapping key. `external_id` is optional and defaults to `candidate_id`.
- Treat Boss card summaries such as `card_work_experience_text` and `card_education_experience_text` as raw upstream context only.
- Prefer downstream PDF-parsed `career_list` and `education_list`; Boss-provided structured lists are only a fallback when local parsing returns no list.
- Do not require Boss to provide `resume_source_id`; Feishu requires the numeric source ID configured in `.env.local`.
- Do not invent fake identity fields for production sync.
- If no real unique field exists after local resume parsing, leave the candidate in `needs_manual_review`.

## Retry rules

- `attachment_failed` retries from upload.
- `talent_failed` retries from talent lookup or create.
- `application_failed` retries from application create.
- `pool_failed` and `note_failed` are optional and must not block the main sync unless the user explicitly wants strict mode.

## Test mode

Use dry-run first to verify candidate selection and config.
Only run apply mode when the local manifest and Feishu IDs are ready.

## Minimal test checklist

1. Fill `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `/Users/apple/ai-worker/feishu-hire-uploader/.env.local`.
2. Fill `FEISHU_HIRE_JOB_ID` and `FEISHU_HIRE_RESUME_SOURCE_ID`.
3. Optional: fill `FEISHU_HIRE_TALENT_POOL_ID` if you want the pool step.
4. Point `FEISHU_HIRE_CANDIDATE_MANIFEST` to `/Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto-lightweight-loop-state.json` or another compatible JSON/JSONL manifest.
5. Ensure the record has a local resume path; real unique identity fields can be absent at this stage because they may still be extracted from the PDF locally.
6. Treat any Boss card summary fields as optional audit context, not as direct Feishu talent payload fields.
7. Run dry-run first, then apply.
