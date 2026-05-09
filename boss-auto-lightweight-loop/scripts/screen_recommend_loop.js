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

const MODE = "screen-and-greet";
const RECOMMEND_PHASE = "recommended_feed_quota_drain";

function loadOptions() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfigOptions(args);
  if (!cfg.jobName) throw new Error("job_name is required. Pass --job-name or configure in default-config.yaml.");
  return {
    ...cfg,
    target: args.target || "",
    runId: args["run-id"] || `screen-${now().replace(/[:.]/g, "-")}`,
    selfCheck: !!args["self-check"],
    dryRun: !!args["dry-run"],
    maxClicks: Number(args["max-clicks"] || 0) || undefined,
  };
}

function recommendProbe(cdp) {
  return cdp.eval(`(() => {
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const d = frame && frame.contentDocument;
    const bodyText = d ? (d.body.innerText || '').trim() : (document.body.innerText || '').trim();
    const hasCards = !!(d || document).querySelector('.geek-card, li.card-item, .candidate-card');
    const quotaHint = /今日沟通额度|剩余.*次|权益.*耗尽|沟通次数|升级套餐/.test(bodyText);
    return {
      isRecommendPage: /推荐牛人|为你推荐|相似牛人|推荐候选人/.test(document.title) || !!d || /推荐牛人|为你推荐/.test(bodyText),
      hasCards,
      cardCount: (d || document).querySelectorAll('.geek-card, li.card-item, .candidate-card').length,
      quotaHint,
      emptyState: /暂无推荐|没有更多|暂无数据/.test(bodyText),
      loginExpired: /登录|扫码登录/.test(bodyText) && !hasCards,
      riskPrompt: /验证码|安全验证|拖动滑块|行为验证/.test(bodyText),
      frameReady: !!d,
      url: location.href,
    };
  })()`);
}

function extractRecommendCandidates(cdp, jobName) {
  return cdp.eval(`(() => {
    const jobName = ${JSON.stringify(jobName)};
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const txt = el => (el.innerText || el.textContent || '').trim();
    const invalidName = line => {
      if (!line) return true;
      if (line.length < 2 || line.length > 8) return true;
      if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系|推荐|相似|期望|学历|经历|掌握|选择/.test(line)) return true;
      if (/^(今天|昨天|前天|刚刚|\\d+分钟前|\\d+小时前|\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日|\\d{4}[./-]\\d{1,2}[./-]\\d{1,2})$/.test(line)) return true;
      if (/K|面议|岁|应届|本科|硕士|博士|大专|专科|研究生|在读/.test(line)) return true;
      if (/Python|Golang|Go|Java|C\\+\\+|Rust|JavaScript|TypeScript|React|Vue|Node\\.js|Spring|Django|Flask|FastAPI|TensorFlow|PyTorch|Docker|MySQL|Redis|SQL|Linux/i.test(line)) return true;
      if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|机器学习|深度学习|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(line)) return true;
      if (/南京|北京|上海|广州|深圳|杭州|成都|武汉|西安|苏州|天津|重庆|长沙|郑州|青岛|大连|宁波|厦门|无锡|佛山|东莞/.test(line)) return true;
      if (jobName && line.includes(jobName)) return true;
      return false;
    };
    const cards = Array.from(doc.querySelectorAll('.geek-card, li.card-item, .candidate-card, [class*="card"]'));
    const results = [];
    const seen = new Set();
    for (const card of cards) {
      const r = card.getBoundingClientRect ? card.getBoundingClientRect() : { width: 1, height: 1 };
      if (!(r.width > 0 && r.height > 0)) continue;
      const btn = Array.from(card.querySelectorAll('button, a, div, span'))
        .find(el => /^打招呼$|^立即沟通$/.test(txt(el)));
      if (!btn) continue;
      const text = txt(card);
      if (!text) continue;
      const lines = text.split(/\\n+/).map(x => x.trim()).filter(Boolean);
      let name = '';
      for (const line of lines) {
        if (invalidName(line)) continue;
        name = line;
        break;
      }
      if (!name) continue;
      let school = '';
      const eduMatch = text.match(/([^\\s]+(?:大学|学院|理工大学|邮电大学|航空航天大学|科学技术大学|师范大學|农业大學|医科大學|中医药大學))/);
      if (eduMatch) school = eduMatch[1];
      const uid = name + '__' + school;
      if (seen.has(uid)) continue;
      seen.add(uid);
      results.push({
        name,
        school,
        text: text.slice(0, 600),
        btnText: txt(btn),
        selectorHint: btn.className || '',
      });
    }
    return { ok: true, candidates: results };
  })()`);
}

function markGreetButton(cdp, name, school) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const school = ${JSON.stringify(school)};
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const txt = el => (el.innerText || el.textContent || '').trim();
    const cards = Array.from(doc.querySelectorAll('.geek-card, li.card-item, .candidate-card, [class*="card"]'));
    const card = cards.find(c => {
      const t = txt(c);
      return t.includes(name) && (!school || t.includes(school));
    });
    if (!card) return { ok: false, reason: 'card_not_found' };
    card.scrollIntoView({ block: 'center', inline: 'center' });
    const btn = Array.from(card.querySelectorAll('button, a, div, span'))
      .find(el => /^打招呼$|^立即沟通$/.test(txt(el)));
    if (!btn) return { ok: false, reason: 'button_not_found' };
    const markerKey = 'data-lobster-greet-target';
    const markerVal = name + '_' + (school || 'none');
    btn.setAttribute(markerKey, markerVal);
    const fr = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
    const br = btn.getBoundingClientRect();
    return {
      ok: true,
      selector: '[' + markerKey + '="' + markerVal + '"]',
      x: fr.x + br.x + br.width / 2,
      y: fr.y + br.y + br.height / 2,
      beforeText: txt(card).slice(0, 400),
    };
  })()`);
}

function confirmGreetStateChange(cdp, name, school) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const school = ${JSON.stringify(school)};
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const txt = el => (el.innerText || el.textContent || '').trim();
    const cards = Array.from(doc.querySelectorAll('.geek-card, li.card-item, .candidate-card, [class*="card"]'));
    const card = cards.find(c => {
      const t = txt(c);
      return t.includes(name) && (!school || t.includes(school));
    });
    if (!card) return { ok: false, changed: false, reason: 'card_not_found', text: '' };
    const text = txt(card);
    const btn = Array.from(card.querySelectorAll('button, a, div, span'))
      .find(el => /^打招呼$|^立即沟通$/.test(txt(el)));
    const hasGreetBtn = !!btn;
    const hasContinued = /继续沟通|已沟通|已联系/.test(text);
    return {
      ok: !hasGreetBtn && hasContinued,
      changed: !hasGreetBtn,
      reason: !hasGreetBtn ? 'greet_btn_gone' : 'still_has_greet_btn',
      text: text.slice(0, 500),
    };
  })()`);
}

function checkQuotaExhausted(cdp) {
  return cdp.eval(`(() => {
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const text = (doc.body.innerText || '').trim();
    return {
      exhausted: /今日沟通额度|剩余.*次.*0|权益.*耗尽|暂无沟通次数|沟通次数已用完/.test(text),
      hintText: text.match(/(今日沟通额度|剩余.*次|权益.*耗尽|暂无沟通次数)[^\\n]{0,60}/)?.[0] || '',
    };
  })()`);
}

function closeBlockingDialogs(cdp, reason) {
  return cdp.eval(`(() => {
    const reason = ${JSON.stringify(reason || "cleanup")};
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (_) {}
    }
    const quotaRe = /权益|额度|沟通次数|沟通额度|升级套餐|暂无沟通次数|次数已用完/;
    const closeRe = /关闭|取消|知道了|我知道了|稍后|暂不开通|再看看|确定/;
    for (const doc of docs) {
      const nodes = Array.from(doc.querySelectorAll('[role="dialog"], .dialog, .modal, .popup, .boss-popup, .dialog-wrap, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="layer"]'));
      const dialog = nodes.find(el => {
        const r = el.getBoundingClientRect && el.getBoundingClientRect();
        const text = el.innerText || el.textContent || "";
        return text && quotaRe.test(text) && (!r || (r.width > 0 && r.height > 0));
      });
      if (!dialog) continue;
      const buttons = Array.from(dialog.querySelectorAll('button, a, div, span, i'));
      const btn = buttons.find(el => closeRe.test((el.innerText || el.textContent || '').trim()))
        || buttons.find(el => /close|cancel|icon-close|dialog-close|modal-close/i.test([el.className, el.getAttribute('aria-label'), el.getAttribute('title')].join(' ')));
      if (btn) {
        btn.click();
        return { ok: true, method: 'dialog_button', reason, text: (dialog.innerText || dialog.textContent || '').slice(0, 120) };
      }
    }
    return { ok: false, reason };
  })()`);
}

function scrollRecommendFeed(cdp) {
  return cdp.eval(`(() => {
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const candidates = [doc.scrollingElement, doc.documentElement, doc.body, ...doc.querySelectorAll('[class*="list"], [class*="scroll"], [class*="recommend"], [class*="content"]')].filter(Boolean);
    let target = candidates.find(el => el.scrollHeight > el.clientHeight + 20);
    if (!target) return { moved: false, reason: 'no_scroll_container' };
    const beforeTop = target.scrollTop;
    const beforeHeight = target.scrollHeight;
    target.scrollBy({ top: Math.max(360, Math.floor(target.clientHeight * 0.8)), behavior: 'auto' });
    return { moved: target.scrollTop !== beforeTop || target.scrollHeight !== beforeHeight, beforeTop, afterTop: target.scrollTop, beforeHeight, afterHeight: target.scrollHeight };
  })()`);
}

function main() {
  const options = loadOptions();
  if (options.selfCheck) {
    _main(options);
    return;
  }

  ensureDir(options.lockDir ? require("path").dirname(options.lockDir) : null);

  if (!acquireLock(options.lockDir, options.lockTtlMinutes, MODE)) {
    console.log(JSON.stringify({ status: "skipped", reason: "lock_exists", mode: MODE }));
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

  if (options.selfCheck) {
    console.log(JSON.stringify({
      status: "ok",
      script: "screen_recommend_loop",
      job_name: options.jobName,
      state_candidates: Object.keys(candidates).length,
      dry_run_supported: true,
    }));
    return;
  }

  const cdp = makeClient({ proxy: options.proxy, target: options.target });

  const probe = recommendProbe(cdp);
  if (!probe.isRecommendPage) {
    console.log(JSON.stringify({ status: "paused", reason: "paused_candidate_list_not_found", mode: MODE, detail: "not_on_recommend_page", url: probe.url }));
    return;
  }
  if (probe.loginExpired || probe.riskPrompt) {
    const reason = probe.riskPrompt ? "paused_captcha_detected" : "paused_login_required";
    console.log(JSON.stringify({ status: "paused", reason, mode: MODE, target: cdp.target }));
    return;
  }
  if (!probe.hasCards) {
    console.log(JSON.stringify({ status: "paused", reason: "paused_candidate_list_not_found", mode: MODE, detail: "no_cards_found" }));
    return;
  }

  let clicked = 0;
  let failed = 0;
  let scanned = 0;
  let skipped = 0;
  let pausedReason = null;
  let consecutiveFail = 0;
  const maxClicks = options.maxClicks || 9999;
  let healthCounter = 0;
  let scrollRounds = 0;
  const attemptedIdsThisRun = new Set();

  while (clicked < maxClicks && !pausedReason) {
    if (healthCounter >= options.healthCheckEveryCandidates) {
      healthCounter = 0;
      const h = pageHealth(cdp);
      if (h.captcha) { pausedReason = "paused_captcha_detected"; break; }
      if (h.loginExpired) { pausedReason = "paused_login_required"; break; }
    }

    const quotaCheck = checkQuotaExhausted(cdp);
    if (quotaCheck.exhausted) {
      pausedReason = "paused_boss_contact_quota_exhausted";
      appendLog(options.logFile, options.runId, MODE, { action: "quota_check", result: "exhausted", hint: quotaCheck.hintText });
      const closed = closeBlockingDialogs(cdp, "recommended_quota_exhausted");
      appendLog(options.logFile, options.runId, MODE, { action: "close_blocking_dialog", result: closed.ok ? "ok" : "not_found", detail: closed });
      break;
    }

    const visible = extractRecommendCandidates(cdp, options.jobName);
    const next = (visible.candidates || []).find(c => {
      const id = candidateId(c.name, c.school);
      const existing = candidates[id];
      if (attemptedIdsThisRun.has(id)) return false;
      return !existing || !SENT_OR_COMPLETED_STATES.has(existing.status);
    });

    if (!next) {
      if (scrollRounds < options.maxListScrollRounds) {
        const moved = scrollRecommendFeed(cdp);
        scrollRounds++;
        appendLog(options.logFile, options.runId, MODE, { action: "recommend_scroll", result: moved.moved ? "moved" : "not_moved", scroll_round: scrollRounds, detail: moved });
        if (moved.moved) {
          sleepMs(900 + Math.floor(Math.random() * 600));
          continue;
        }
      }
      appendLog(options.logFile, options.runId, MODE, { action: "recommend_scan", result: "no_more_eligible", scroll_rounds: scrollRounds });
      break;
    }

    scanned++;
    healthCounter++;
    const id = candidateId(next.name, next.school);
    attemptedIdsThisRun.add(id);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: id, source: "recommended_feed", action: "screen_recommended", result: "eligible" });

    const marked = markGreetButton(cdp, next.name, next.school);
    if (!marked.ok) {
      candidates[id] = {
        ...(candidates[id] || {}),
        candidate_id: id,
        name: next.name,
        school: next.school || "",
        job_name: options.jobName,
        source: "recommended_feed",
        status: "skipped_identity_incomplete",
        decision: "skip",
        skip_reason: marked.reason,
        last_observation: marked.reason,
      };
      skipped++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: id, source: "recommended_feed", action: "recommended_greet", result: "skipped", error_code: marked.reason });
      continue;
    }

    let confirmed;
    if (options.dryRun) {
      confirmed = { ok: true, changed: true, reason: "dry_run" };
    } else {
      cdp.clickAt(marked.selector);
      sleepMs(900 + Math.floor(Math.random() * 600));
      confirmed = confirmGreetStateChange(cdp, next.name, next.school);

      if (!confirmed.changed) {
        const fallbackClick = cdp.eval(`(() => {
          const name = ${JSON.stringify(next.name)};
          const school = ${JSON.stringify(next.school)};
          const frame = document.querySelector('iframe[name="recommendFrame"]');
          const doc = frame && frame.contentDocument ? frame.contentDocument : document;
          const txt = el => (el.innerText || el.textContent || '').trim();
          const cards = Array.from(doc.querySelectorAll('.geek-card, li.card-item, .candidate-card, [class*="card"]'));
          const card = cards.find(c => {
            const t = txt(c);
            return t.includes(name) && (!school || t.includes(school));
          });
          if (!card) return { clicked: false, reason: 'card_not_found' };
          const btn = Array.from(card.querySelectorAll('button, a, div, span'))
            .find(el => /^打招呼$|^立即沟通$/.test(txt(el)));
          if (!btn) return { clicked: false, reason: 'btn_not_found' };
          btn.click();
          return { clicked: true, method: 'dom_click' };
        })()`);
        if (fallbackClick.clicked) {
          sleepMs(900 + Math.floor(Math.random() * 600));
          confirmed = confirmGreetStateChange(cdp, next.name, next.school);
        }
      }
    }

    const at = now();
    if (!confirmed.changed) {
      consecutiveFail++;
      candidates[id] = {
        ...(candidates[id] || {}),
        candidate_id: id,
        name: next.name,
        school: next.school || "",
        job_name: options.jobName,
        source: "recommended_feed",
        status: "skipped_hard_filter",
        decision: "skip",
        skip_reason: "greet_no_state_change",
        last_observation: `consecutive_fail_${consecutiveFail}`,
        card_work_experience_text: next.text.slice(0, 300),
        history: [...((candidates[id] && candidates[id].history) || []), { at, run_id: options.runId, source: "recommended_feed", action: "recommended_greet", result: "failed", error_code: "greet_no_state_change" }],
      };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: id, source: "recommended_feed", action: "recommended_greet", result: "failed", error_code: "greet_no_state_change", consecutive_fail: consecutiveFail });

      if (consecutiveFail >= 3) {
        const deepQuota = checkQuotaExhausted(cdp);
        if (deepQuota.exhausted || quotaCheck.exhausted) {
          pausedReason = "paused_boss_contact_quota_exhausted";
          const closed = closeBlockingDialogs(cdp, "recommended_quota_exhausted");
          appendLog(options.logFile, options.runId, MODE, { action: "close_blocking_dialog", result: closed.ok ? "ok" : "not_found", detail: closed });
        } else {
          pausedReason = "paused_boss_contact_quota_exhausted";
          appendLog(options.logFile, options.runId, MODE, { action: "consecutive_fail_quota_assumed", consecutive_fail: consecutiveFail });
        }
        break;
      }
      continue;
    }

    consecutiveFail = 0;
    scrollRounds = 0;
    candidates[id] = {
      ...(candidates[id] || {}),
      candidate_id: id,
      name: next.name,
      school: next.school || "",
      job_name: options.jobName,
      source: "recommended_feed",
      card_work_experience_text: next.text.slice(0, 300),
      status: "attachment_requested",
      decision: "auto_greet_recommended_quota_drain",
      last_observation: next.school ? "recommended_greet_sent_request_resume" : "recommended_greet_sent_request_resume; school_missing",
      greeted_at: at,
      message_sent_at: at,
      last_error: null,
      history: [...((candidates[id] && candidates[id].history) || []), { at, run_id: options.runId, source: "recommended_feed", action: "recommended_greet", result: "ok", from: "discovered", to: "attachment_requested" }],
    };
    clicked++;
    appendLog(options.logFile, options.runId, MODE, { candidate_id: id, source: "recommended_feed", action: "recommended_greet", status_to: "attachment_requested", result: "ok" });

    if (clicked < maxClicks && !options.dryRun) {
      sleepMs(randomSleepSeconds(options.recommendedGreetIntervalMin, options.recommendedGreetIntervalMax) * 1000);
    }

    if (Object.keys(candidates).length % options.stateFlushBatchSize === 0) {
      saveState(options.stateFile, state, options.jobName);
    }
  }

  saveState(options.stateFile, state, options.jobName);
  const status = pausedReason ? "paused" : "ok";
  console.log(JSON.stringify({
    status,
    mode: MODE,
    phase: RECOMMEND_PHASE,
    scanned,
    clicked,
    failed,
    skipped,
    paused_reason: pausedReason,
    run_id: options.runId,
    target: cdp.target,
  }));
}

main();
