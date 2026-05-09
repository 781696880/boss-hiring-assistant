# Automation Lock

## 适用场景

适用于自动化、定时任务、无人值守运行和 `runtime=lite` 场景。目标是避免多轮任务并发执行，导致重复发消息、重复下载简历、重复写入同步队列。

## 推荐定时任务

采用两段式任务：

```text
screen-and-greet：每天低频运行 1-2 次
follow-greeted：在 screen-and-greet 后延迟运行
collect-resumes：工作时间内较高频运行
```

`screen-and-greet` 是高风险动作，需要低频运行；其中推荐牛人页阶段按平台当日沟通额度逐个打招呼直到额度耗尽或列表到底，聊天页阶段仍按 `max_greet_per_run` 小批量发送求附件简历消息。`collect-resumes` 是低风险动作，可以较高频运行。`screen-and-send` 已废弃为 `screen-and-greet` 的旧入口别名。`follow-greeted` 只处理已打招呼候选人进入聊天后的求简历动作，也需要本地运行锁。

## Automation Prompt

### screen-and-greet

```text
runtime=lite
mode=screen-and-greet
job_name=岗位名
使用 assets/default-config.yaml 默认配置。
启动后必须先执行本地运行锁检查：读取 lock_dir 和 lock_ttl_minutes；拿到锁后才允许读取 Boss 页面、先消耗推荐牛人页打招呼额度、再筛选聊天页候选人并发送求附件简历消息、写本地状态。
如果锁存在且未过期，直接输出 {"status":"skipped","reason":"lock_exists","mode":"screen-and-greet"}。
遇到验证码、登录失效、候选人身份不匹配、连续发送失败、下载失败或队列写入失败时立即停止，并释放本轮获得的锁。
结束时只输出短 JSON 摘要。
```

### follow-greeted

```text
runtime=lite
mode=follow-greeted
使用 assets/default-config.yaml 默认配置。
启动后必须先执行本地运行锁检查：读取 lock_dir 和 lock_ttl_minutes；拿到锁后才允许检查 first_contact_sent 候选人是否进入聊天线程，并在身份校验后发送求附件简历消息。
只处理 state_file 中 status=first_contact_sent 的候选人。
如果锁存在且未过期，直接输出 {"status":"skipped","reason":"lock_exists","mode":"follow-greeted"}。
遇到验证码、登录失效、候选人身份不匹配或连续发送失败时立即停止，并释放本轮获得的锁。
结束时只输出短 JSON 摘要。
```

### collect-resumes

```text
runtime=lite
mode=collect-resumes
使用 assets/default-config.yaml 默认配置。
启动后必须先执行本地运行锁检查：读取 lock_dir 和 lock_ttl_minutes；拿到锁后才允许检查已触达候选人、接收附件、下载简历、更新状态和写入 sync_queue_file。
只跟进 state_file 中 status=attachment_requested、attachment_sent_by_candidate、attachment_received、resume_downloaded、download_failed 或 sync_queue_failed 的候选人，不扩大扫描范围。
如果锁存在且未过期，直接输出 {"status":"skipped","reason":"lock_exists","mode":"collect-resumes"}。
遇到验证码、登录失效、候选人身份不匹配、下载失败或队列写入失败时立即停止，并释放本轮获得的锁。
结束时只输出短 JSON 摘要。
```

## 本地运行锁协议

默认配置来自 `assets/default-config.yaml`：

```yaml
lock_dir: /Users/apple/Documents/boss-auto-lightweight-loop-python/briefs/boss-auto.lockdir
lock_ttl_minutes: 30
```

获取锁：

1. 确保 `briefs`、`briefs/logs`、`resumes` 目录存在。
2. 尝试原子创建 `lock_dir`。
3. 创建成功，写入 `lock_dir/meta.json`，继续执行任务。
4. 创建失败，读取 `meta.json` 或目录 mtime。
5. 如果锁年龄小于 `lock_ttl_minutes`，跳过本轮。
6. 如果锁年龄大于 `lock_ttl_minutes`，删除陈旧锁并重试一次。

释放锁：

- 只有本轮成功创建的锁才允许释放。
- 正常完成、异常停止、失败退出都必须释放。

## JSON 输出示例

锁冲突跳过：

```json
{"status":"skipped","reason":"lock_exists","mode":"collect-resumes"}
```

获取锁后成功执行：

```json
{"status":"ok","mode":"collect-resumes","lock":"released","received":2,"downloaded":2,"queued":2}
```
