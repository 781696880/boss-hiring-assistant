# Boss Chat Rules

## 继承规则

发送、接收附件、下载附件前必须读取：
- `./boss-send-recipe.md`
- `./browser-routing.md`

在自动化、定时任务、无人值守或 `runtime=lite` 场景中，`runtime-lite.md` 只描述运行 delta，不内置第二份发送、接收、下载和浏览器路由实现；进入 `follow-greeted`、`collect-resumes`、`screen-and-greet` 的聊天发送动作时，本文件和上面两个 reference 都属于 mode 必读清单。

本文件只补充自动闭环中的编排规则。

## 固定求简历模板

```text
你好，我这边看了你的经历，和当前岗位匹配度不错。方便的话，可以发一份最新附件简历给我吗？我这边进一步评估后再和你沟通，谢谢。
```

默认使用 `assets/default-config.yaml` 中的 `request_resume_message`；上面文本是当前默认值。默认不为每位候选人自由生成不同话术。

## 自动发送步骤

本节仅适用于 `inbound_chat` 或已经进入聊天线程的候选人。推荐牛人页卡片打招呼由 `screen-and-greet` 调用 `boss-greet-recipe.md`。Boss 侧预设打招呼语固定视为求附件简历消息，打招呼成功后写 `attachment_requested`。

1. 从 `auto_contact_pool` 取候选人。
2. 通过 `web-access` 打开候选人线程。
3. 校验候选人姓名、岗位与 `candidate_id`；学校存在时作为增强校验信号，不再要求学校必须可读。
4. 填入固定模板：合并执行聚焦、写入、派发输入事件和输入框文本确认。
5. 输入确认后只等待 `input_to_send_delay_ms`，默认 200ms，然后使用 `web-access clickAt` 点击发送。
6. 在 `send_confirm_timeout_ms` 内等待短时确认，优先确认输入框清空、目标线程最后一条真实消息短摘要或当前卡片状态变化；不要长时间等待“已读/送达”。
7. 写入 `attachment_requested`。
8. 随机等待 `send_interval_seconds_min` 到 `send_interval_seconds_max`。

## 附件回收步骤

只处理状态文件中的候选人。

检测信号：

- `对方想发送附件简历给您，您是否同意`
- `同意`
- `接收`
- `点击预览附件简历`
- `附件简历`
- `.pdf`
- `.doc`
- `.docx`

处理顺序：

1. `collect-resumes` 获取运行锁后、处理第一位候选人前，优先通过 CDP 将下载目录设置为 `resume_download_dir`；设置失败时回退默认下载目录 + 移动/重命名流程。
2. 已有“同意/接收”按钮时，先点击接收；如果同一候选人线程内出现 2 个可点击的“同意/接收”，选择消息流中第一个属于附件请求卡片的按钮。
3. 已有附件卡片时，点击预览。
4. 在预览层只找外层预览壳右上角的“下载”文本或按钮并点击，不要寻找 PDF 直链、签名 URL 或文件路径。
5. 等待本地下载文件出现：按配置轮询，排除 `.crdownload/.tmp`，并确认文件大小连续 2 次稳定。
6. 若下载目录设置成功，在 `resume_download_dir` 内直接重命名为规范文件名；若设置失败，从默认下载目录移动到 `resume_download_dir` 后重命名。完成文件校验/hash 后标记 `resume_downloaded` 并立即 flush。
7. 写入本地待同步队列，交给飞书招聘系统同步 skill；队列 JSONL 追加成功后标记 `ready_for_hire_sync` 并立即 flush。
8. 关闭/退出预览界面，短确认回到当前候选人的聊天线程。
9. 最后回复确认收到，短确认成功后标记 `boss_completed`；采用批量化 flush 时，该状态在批次统一写入时落盘。

确认回复模板：

```text
简历已收到，我们会尽快筛选，合适的话会联系您。
```

如果确认回复发送失败，只允许补发一次。补发仍失败则保持 `ready_for_hire_sync`，进入 `paused_send_failed`；下次只补确认回复，不重复下载或重复写队列。

## 禁止行为

- 不扫描状态文件之外的候选人。
- 不重复索要附件简历。
- 不向已经 `boss_completed` 的候选人发送消息。
- 不用截图/OCR 判断聊天内容。
- 不把 DOM `click()` 当作批量发送默认路径。
- 不因一个候选人失败而跳到无关候选人继续扩大影响。

## 下载归档

`collect-resumes` 优先让 Chrome 直接下载到：

```text
/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes
```

文件名重命名为：

```text
{job_name}_候选人姓名_[学校可选]_YYYYMMDD.{ext}
```

如果无法设置 Chrome 下载目录，则回退到默认下载目录，下载完成后再移动到上述目录并重命名。无论哪条路径，都不得覆盖同名已有文件；命名冲突先追加递增序号，只有序号路径仍异常冲突或需要区分相同序号来源时，才在计算出 `resume_hash` 后追加短 hash。
