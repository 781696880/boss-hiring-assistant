#!/usr/bin/env node
"use strict";

const {
  parseArgs,
  loadConfigOptions,
  makeClient,
  loadState,
  getCandidates,
  saveState,
  appendLog,
  candidateId,
  now,
  randomSleepSeconds,
  pageHealth,
  acquireLock,
  releaseLock,
  ensureDir,
  sleepMs,
  SENT_OR_COMPLETED_STATES,
} = require("./lib/common");

const MODE = "send-resume-requests";
const SCREEN_GREET_MODE = "screen-and-greet";

function loadOptions() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfigOptions(args);
  if (!cfg.jobName) throw new Error("job_name is required. Pass --job-name or configure in default-config.yaml.");
  return {
    ...cfg,
    target: args.target || "",
    runId: args["run-id"] || `send-${now().replace(/[:.]/g, "-")}`,
    selfCheck: !!args["self-check"],
    dryRun: !!args["dry-run"],
    candidateIds: String(args["candidate-id"] || args["candidate-ids"] || "").split(",").map(s => s.trim()).filter(Boolean),
  };
}

function invalidCandidateName(name, jobName) {
  const value = String(name || "").trim();
  if (value.length < 2 || value.length > 8) return true;
  if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系/.test(value)) return true;
  if (/^(今天|昨天|前天|刚刚|\d+分钟前|\d+小时前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/.test(value)) return true;
  if (/Python|Golang|Go|Java|C\+\+|Rust|JavaScript|TypeScript|React|Vue|Node\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(value)) return true;
  if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(value)) return true;
  if (jobName && value.includes(jobName)) return true;
  return false;
}

function isAlreadyRequested(candidate) {
  return !!candidate && (
    SENT_OR_COMPLETED_STATES.has(candidate.status) ||
    candidate.skip_reason === "already_contacted" ||
    /already_requested|message_sent|recommended_greet_sent_request_resume/.test(String(candidate.last_observation || ""))
  );
}

function findAlreadyRequested(candidates, candidate) {
  const direct = candidates[candidate.id];
  if (isAlreadyRequested(direct)) return direct;
  const targetName = String(candidate.name || "").trim();
  const targetSchool = String(candidate.school || "").trim();
  for (const existing of Object.values(candidates)) {
    if (!existing || !existing.candidate_id) continue;
    if (existing.job_name && existing.job_name !== candidate.jobName) continue;
    if (String(existing.name || "").trim() !== targetName) continue;
    if (targetSchool && existing.school && String(existing.school).trim() !== targetSchool) continue;
    if (isAlreadyRequested(existing)) return existing;
  }
  return null;
}

function loadLatestCandidates(options) {
  return getCandidates(loadState(options.stateFile));
}

function getTargets(candidates, options) {
  const neverSendStatuses = new Set([
    "skipped_duplicate",
    "skipped_hard_filter",
    "skipped_identity_incomplete",
    "skipped_already_boss_completed",
  ]);
  const pool = Object.values(candidates).filter(c => {
    if (!c || !c.candidate_id || !c.name) return false;
    if (invalidCandidateName(c.name, options.jobName)) return false;
    if (c.source !== "inbound_chat") return false;
    if (neverSendStatuses.has(c.status) || c.skip_reason === "already_contacted") return false;
    if (SENT_OR_COMPLETED_STATES.has(c.status)) return false;
    if (c.hard_filters_passed !== true) return false;
    if (Number(c.rating) < options.autoSendThreshold) return false;
    if (options.candidateIds.length && !options.candidateIds.includes(c.candidate_id)) return false;
    return true;
  });

  pool.sort((a, b) => {
    const ra = Number(a.rating) || 0;
    const rb = Number(b.rating) || 0;
    if (rb !== ra) return rb - ra;
    const ta = String(a.last_message_at || a.updated_at || a.created_at || "");
    const tb = String(b.last_message_at || b.updated_at || b.created_at || "");
    return tb.localeCompare(ta);
  });

  return pool.slice(0, options.maxGreetPerRun).map(c => ({
    id: c.candidate_id,
    name: c.name,
    school: c.school || "",
    jobName: c.job_name || options.jobName,
    status: c.status || "",
    rating: c.rating,
  }));
}

function getVisibleItems(cdp) {
  return cdp.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.geek-item'));
    return items.slice(0, 80).map((el, idx) => {
      if (!el.id) el.setAttribute('data-lobster-send-target', 'visible_' + idx);
      return {
      selector: el.id ? '#' + CSS.escape(el.id) : '[data-lobster-send-target="visible_' + idx + '"]',
      id: el.id || ('visible_' + idx),
      text: (el.innerText || el.textContent || '').trim().slice(0, 400),
    };
    });
  })()`);
}

function probeConversation(cdp, name, jobName, message) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const jobName = ${JSON.stringify(jobName)};
    const message = ${JSON.stringify(message)};
    const selected = document.querySelector('.geek-item.selected, .geek-item.active, .geek-item.cur');
    const selectedText = (selected?.innerText || selected?.textContent || '').trim();
    const conv = document.querySelector('.chat-conversation');
    const convText = (conv?.innerText || conv?.textContent || '').trim();
    const bodyText = (document.body.innerText || '').trim().slice(0, 3000);
    const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
    const sendBtn = document.querySelector('.chat-container-private .submit, .chat-input .submit, .submit');
    const identity = selectedText.includes(name) || convText.includes(name);
    const jobMatched = !jobName || selectedText.includes(jobName) || convText.includes(jobName) || bodyText.includes(jobName);
    const alreadyRequested = convText.includes(message) || bodyText.includes(message);
    return {
      identity,
      jobMatched,
      alreadyRequested,
      hasEditor: !!editor,
      hasSendButton: !!sendBtn,
      selectedText: selectedText.slice(0, 500),
      conversationText: convText.slice(0, 900),
      editorText: (editor?.innerText || editor?.textContent || '').trim().slice(0, 200),
    };
  })()`);
}

function fillMessage(cdp, message) {
  return cdp.eval(`(() => {
    const message = ${JSON.stringify(message)};
    const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
    if (!editor) return { ok: false, reason: 'editor_not_found' };
    editor.focus();
    editor.innerHTML = '';
    editor.textContent = message;
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: message }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    const confirmed = (editor.innerText || editor.textContent || '').trim();
    return { ok: confirmed.includes(message), editorText: confirmed.slice(0, 200) };
  })()`);
}

function clickSend(cdp) {
  return cdp.eval(`(() => {
    const btn = document.querySelector('.chat-container-private .submit, .chat-input .submit, .submit');
    if (!btn) return { ok: false, reason: 'send_button_not_found' };
    const r = btn.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return { ok: false, reason: 'send_button_hidden' };
    return { ok: true, selector: '.submit', rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
}

function confirmSent(cdp, message, timeoutMs) {
  return cdp.eval(`(() => {
    const message = ${JSON.stringify(message)};
    const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
    const editorText = (editor?.innerText || editor?.textContent || '').trim();
    const conv = document.querySelector('.chat-conversation');
    const convText = (conv?.innerText || conv?.textContent || '').trim();
    const bubbles = Array.from(document.querySelectorAll('.chat-message, .message-bubble, [class*="message"]'));
    const lastBubble = bubbles[bubbles.length - 1];
    const lastBubbleText = lastBubble ? (lastBubble.innerText || lastBubble.textContent || '').trim() : '';
    const editorCleared = !editorText || editorText.length === 0 || !editorText.includes(message);
    const convHasMessage = convText.includes(message);
    const lastHasMessage = lastBubbleText.includes(message);
    return {
      ok: editorCleared && (convHasMessage || lastHasMessage),
      editorCleared,
      convHasMessage,
      lastBubbleText: lastBubbleText.slice(0, 200),
      editorText: editorText.slice(0, 200),
    };
  })()`);
}

function switchToCandidate(cdp, itemSelector) {
  if (!itemSelector) throw new Error("candidate_selector_missing");
  cdp.clickAt(itemSelector);
  sleepMs(700 + Math.floor(Math.random() * 400));
}

function main() {
  const options = loadOptions();
  if (options.selfCheck) {
    _main(options);
    return;
  }

  ensureDir(options.lockDir ? require("path").dirname(options.lockDir) : null);

  if (!acquireLock(options.lockDir, options.lockTtlMinutes, SCREEN_GREET_MODE)) {
    console.log(JSON.stringify({ status: "skipped", reason: "lock_exists", mode: SCREEN_GREET_MODE }));
    process.exit(0);
  }

  try {
    _main(options);
  } finally {
    releaseLock(options.lockDir);
  }
}

function _main(options) {
  const state = loadState(options.stateFile);
  const candidates = getCandidates(state);
  const targets = getTargets(candidates, options);

  if (options.selfCheck) {
    console.log(JSON.stringify({
      status: "ok",
      script: "send_resume_requests",
      job_name: options.jobName,
      pending_send_targets: targets.length,
      max_send: options.maxGreetPerRun,
      dry_run_supported: true,
    }));
    return;
  }

  const cdp = makeClient({ proxy: options.proxy, target: options.target });
  const health = pageHealth(cdp);
  if (health.loginExpired || health.captcha || !health.hasChatList) {
    const reason = health.captcha ? "paused_captcha_detected" : "paused_login_required";
    console.log(JSON.stringify({ status: "paused", reason, sent: 0, run_id: options.runId, target: cdp.target }));
    return;
  }

  const visible = getVisibleItems(cdp);
  let scanned = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let pausedReason = null;
  let healthCounter = 0;
  let consecutiveSendFail = 0;
  let batch = [];

  for (const candidate of targets) {
    if (sent >= options.maxGreetPerRun) break;
    if (pausedReason) break;

    if (healthCounter >= options.healthCheckEveryCandidates) {
      healthCounter = 0;
      const h = pageHealth(cdp);
      if (h.captcha) { pausedReason = "paused_captcha_detected"; break; }
      if (h.loginExpired) { pausedReason = "paused_login_required"; break; }
    }

    const item = visible.find(v =>
      v.text.includes(candidate.name) &&
      (!candidate.school || v.text.includes(candidate.school) || v.text.includes(candidate.jobName))
    );
    if (!item) {
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "skipped", error_code: "candidate_not_visible" });
      skipped++;
      continue;
    }

    scanned++;
    healthCounter++;
    if (!options.dryRun) switchToCandidate(cdp, item.selector);

    const probe = options.dryRun
      ? { identity: true, jobMatched: true, alreadyRequested: false, hasEditor: true, hasSendButton: true }
      : probeConversation(cdp, candidate.name, candidate.jobName, options.requestResumeMessage);

    if (!probe.identity || !probe.jobMatched) {
      pausedReason = "paused_candidate_identity_mismatch";
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "paused", error_code: pausedReason });
      break;
    }

    if (probe.alreadyRequested) {
      const before = candidates[candidate.id] || {};
      candidates[candidate.id] = {
        ...before,
        candidate_id: candidate.id,
        name: candidate.name,
        school: candidate.school || "",
        job_name: candidate.jobName,
        status: "attachment_requested",
        last_observation: "already_requested_on_page",
        history: [...(before.history || []), { at: now(), run_id: options.runId, source: "inbound_chat", action: "send_resume_request", from: before.status || null, to: "attachment_requested", result: "already_requested" }],
      };
      batch.push(candidate.id);
      skipped++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "already_requested" });
      saveState(options.stateFile, state, options.jobName);
      batch = [];
      continue;
    }

    if (!probe.hasEditor || !probe.hasSendButton) {
      failed++;
      consecutiveSendFail++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "failed", error_code: "editor_or_send_button_missing" });
      if (consecutiveSendFail >= 3) {
        pausedReason = "paused_send_failed";
        break;
      }
      continue;
    }

    const latestCandidates = loadLatestCandidates(options);
    const alreadyRequested = findAlreadyRequested(latestCandidates, candidate);
    if (alreadyRequested) {
      skipped++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, {
        candidate_id: candidate.id,
        source: "inbound_chat",
        action: "send_resume_request",
        result: "skipped",
        error_code: "already_requested_in_local_state",
        matched_candidate_id: alreadyRequested.candidate_id,
        matched_status: alreadyRequested.status || null,
      });
      continue;
    }

    if (options.dryRun) {
      sent++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "dry_run" });
      continue;
    }

    const filled = fillMessage(cdp, options.requestResumeMessage);
    if (!filled.ok) {
      failed++;
      consecutiveSendFail++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "failed", error_code: filled.reason || "message_fill_failed" });
      if (consecutiveSendFail >= 3) {
        pausedReason = "paused_send_failed";
        break;
      }
      continue;
    }

    sleepMs(options.inputDelayMs);

    const sendProbe = clickSend(cdp);
    if (!sendProbe.ok) {
      failed++;
      consecutiveSendFail++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "failed", error_code: sendProbe.reason || "send_button_not_found" });
      if (consecutiveSendFail >= 3) {
        pausedReason = "paused_send_failed";
        break;
      }
      continue;
    }

    cdp.clickAt(sendProbe.selector);
    sleepMs(options.confirmTimeoutMs);

    const confirmed = confirmSent(cdp, options.requestResumeMessage, options.confirmTimeoutMs);
    if (!confirmed.ok) {
      failed++;
      consecutiveSendFail++;
      appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "failed", error_code: "send_confirm_failed", confirm_detail: confirmed });
      if (consecutiveSendFail >= 3) {
        pausedReason = "paused_send_failed";
        break;
      }
      continue;
    }

    consecutiveSendFail = 0;
    const before = candidates[candidate.id] || {};
    candidates[candidate.id] = {
      ...before,
      candidate_id: candidate.id,
      name: candidate.name,
      school: candidate.school || "",
      job_name: candidate.jobName,
      status: "attachment_requested",
      decision: before.decision || "auto_send",
      message_sent_at: now(),
      last_observation: "message_sent",
      skip_reason: null,
      history: [...(before.history || []), { at: now(), run_id: options.runId, source: "inbound_chat", action: "send_resume_request", from: before.status || null, to: "attachment_requested", result: "ok" }],
    };
    batch.push(candidate.id);
    sent++;
    appendLog(options.logFile, options.runId, SCREEN_GREET_MODE, { candidate_id: candidate.id, source: "inbound_chat", action: "send_resume_request", result: "sent" });
    saveState(options.stateFile, state, options.jobName);
    batch = [];

    if (sent < options.maxGreetPerRun) {
      sleepMs(randomSleepSeconds(options.sendIntervalMin, options.sendIntervalMax) * 1000);
    }

    if (batch.length >= options.stateFlushBatchSize) {
      saveState(options.stateFile, state, options.jobName);
      batch = [];
    }
  }

  saveState(options.stateFile, state, options.jobName);
  console.log(JSON.stringify({
    status: pausedReason ? "paused" : "ok",
    mode: SCREEN_GREET_MODE,
    phase: "send_resume_request_in_chat",
    scanned,
    sent,
    skipped,
    failed,
    paused_reason: pausedReason,
    run_id: options.runId,
    target: cdp.target,
  }));
}

main();
