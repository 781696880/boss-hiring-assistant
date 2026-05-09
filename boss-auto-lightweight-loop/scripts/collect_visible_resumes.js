#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  parseArgs,
  loadConfigOptions,
  makeClient,
  loadState,
  getCandidates,
  saveState,
  appendLog,
  now,
  pageHealth,
  acquireLock,
  releaseLock,
  ensureDir,
  sleepMs,
  fileHash,
  safeFilename,
  requestJson,
  COLLECT_STATUSES,
} = require("./lib/common");

const MODE = "collect-resumes";

function loadOptions() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfigOptions(args);
  if (!cfg.jobName) throw new Error("job_name is required. Pass --job-name or configure in default-config.yaml.");
  return {
    ...cfg,
    target: args.target || "",
    runId: args["run-id"] || `collect-${now().replace(/[:.]/g, "-")}`,
    selfCheck: !!args["self-check"],
    dryRun: !!args["dry-run"],
  };
}

function invalidCandidateName(name, jobName) {
  const value = String(name || "").trim();
  if (value.length < 2 || value.length > 8) return true;
  if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系/.test(value)) return true;
  if (/^(今天|昨天|前天|刚刚|\d+分钟前|\d+小时前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/.test(value)) return true;
  if (/^\d+\s*[-~]\s*\d+K$/i.test(value)) return true;
  if (/Python|Golang|Go|Java|C\+\+|Rust|JavaScript|TypeScript|React|Vue|Node\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(value)) return true;
  if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(value)) return true;
  if (jobName && value.includes(jobName)) return true;
  return false;
}

function collectPriority(status) {
  if (status === "paused_send_failed") return -1;
  if (status === "attachment_received" || status === "download_failed" || status === "paused_download_failed") return 0;
  if (status === "attachment_sent_by_candidate") return 1;
  if (status === "resume_downloaded" || status === "sync_queue_failed") return 2;
  return 3;
}

function getCollectTargets(candidates, maxCollect, jobName) {
  const pool = Object.values(candidates).filter(c => {
    if (!c || !c.candidate_id || !c.name) return false;
    if (invalidCandidateName(c.name, jobName)) return false;
    if (!COLLECT_STATUSES.has(c.status)) return false;
    if (c.status === "boss_completed") return false;
    if (c.status === "ready_for_hire_sync" && !c.boss_completed_at) return true;
    return true;
  });
  pool.sort((a, b) => {
    const pa = collectPriority(a.status);
    const pb = collectPriority(b.status);
    if (pa !== pb) return pa - pb;
    const ta = String(a.message_sent_at || a.resume_downloaded_at || a.ready_for_hire_sync_at || "");
    const tb = String(b.message_sent_at || b.resume_downloaded_at || b.ready_for_hire_sync_at || "");
    return tb.localeCompare(ta);
  });
  return pool.slice(0, maxCollect).map(c => ({
    id: c.candidate_id,
    name: c.name,
    school: c.school || "",
    jobName: c.job_name || "",
    status: c.status,
    localResumePath: c.local_resume_path || null,
    resumeHash: c.resume_hash || null,
  }));
}

function getVisibleItems(cdp) {
  return cdp.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.geek-item'));
    return items.slice(0, 80).map((el, idx) => {
      if (!el.id) el.setAttribute('data-boss-auto-thread-target', 'thread_' + idx);
      return {
      selector: el.id ? '#' + CSS.escape(el.id) : '[data-boss-auto-thread-target="thread_' + idx + '"]',
      id: el.id || ('thread_' + idx),
      text: (el.innerText || el.textContent || '').trim().slice(0, 400),
    };
    });
  })()`);
}

function searchThreadByName(cdp, target, options) {
  let search = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    search = cdp.eval(`(() => {
      const name = ${JSON.stringify(target.name)};
      const actionId = 'thread-search-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      document.querySelectorAll('[data-boss-auto-search-id], [data-boss-auto-search-open-id]').forEach(el => {
        el.removeAttribute('data-boss-auto-search-id');
        el.removeAttribute('data-boss-auto-search-open-id');
      });
      const visible = el => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textHint = el => [
        el.getAttribute?.('placeholder'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title'),
        el.className,
        el.parentElement?.className,
        el.parentElement?.innerText,
      ].filter(Boolean).join(' ');
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter(visible)
        .filter(el => !el.closest('.chat-conversation, [class*="editor"], [class*="input-box"]'))
        .filter(el => !el.closest('.chat-job-search, .chat-job, .job-select, [class*="job-select"], [class*="dropmenu"]'))
        .filter(el => {
          const r = el.getBoundingClientRect();
          const hint = textHint(el);
          return r.x >= 180 && r.x < 560 && r.y >= 90 && r.y < 230 && (/搜|搜索|查找|姓名|候选人|牛人|联系人|search/i.test(hint) || el.tagName === 'INPUT');
        })
        .sort((a, b) => {
          const ah = /搜|搜索|查找|search/i.test(textHint(a)) ? 0 : 1;
          const bh = /搜|搜索|查找|search/i.test(textHint(b)) ? 0 : 1;
          if (ah !== bh) return ah - bh;
          return a.getBoundingClientRect().y - b.getBoundingClientRect().y;
        });
      const input = inputs[0];
      if (!input) {
        const exactOpeners = Array.from(document.querySelectorAll('.chat-search-btn'));
        const fallbackOpeners = Array.from(document.querySelectorAll('[class*="search"]'))
          .filter(el => !el.classList?.contains('chat-job-search') && !el.closest('.chat-job-search, .chat-job, .job-select, [class*="job-select"], [class*="dropmenu"]'));
        const opener = [...exactOpeners, ...fallbackOpeners]
          .filter(visible)
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.x >= 180 && r.x < 560 && r.y >= 90 && r.y < 230;
          })
          .sort((a, b) => {
            const ae = a.classList?.contains('chat-search-btn') ? 0 : 1;
            const be = b.classList?.contains('chat-search-btn') ? 0 : 1;
            if (ae !== be) return ae - be;
            return b.getBoundingClientRect().x - a.getBoundingClientRect().x;
          })[0];
        if (opener) {
          opener.setAttribute('data-boss-auto-search-open-id', actionId);
          const r = opener.getBoundingClientRect();
          return { ok: false, reason: 'search_input_not_found', openSelector: '[data-boss-auto-search-open-id="' + actionId + '"]', openerClass: String(opener.className || '').slice(0, 80), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }
        return { ok: false, reason: 'search_input_not_found' };
      }
      input.setAttribute('data-boss-auto-search-id', actionId);
      input.scrollIntoView({ block: 'center' });
      input.focus();
      if (input.isContentEditable) {
        input.textContent = name;
      } else {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, name);
        else input.value = name;
      }
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: name }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: name }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      const r = input.getBoundingClientRect();
      return { ok: true, selector: '[data-boss-auto-search-id="' + actionId + '"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hint: textHint(input).slice(0, 120) };
    })()`);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "search_thread", result: search.ok ? "input" : "failed", detail: search });
    if (search.ok) break;
    if (search.openSelector && attempt === 0) {
      cdp.clickAt(search.openSelector);
      sleepMs(500);
      continue;
    }
    break;
  }
  if (!search.ok) return { item: null, search };
  sleepMs(900);

  const item = cdp.eval(`(() => {
    const name = ${JSON.stringify(target.name)};
    const school = ${JSON.stringify(target.school || "")};
    const jobName = ${JSON.stringify(target.jobName || "")};
    const actionId = 'thread-result-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-thread-result-id]').forEach(el => el.removeAttribute('data-boss-auto-thread-result-id'));
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const items = Array.from(document.querySelectorAll('.geek-item')).filter(visible);
    const matches = items.map((el, idx) => ({ el, idx, text: (el.innerText || el.textContent || '').trim() }))
      .filter(v => v.text.includes(name))
      .sort((a, b) => {
        const as = school && a.text.includes(school) ? 0 : jobName && a.text.includes(jobName) ? 1 : 2;
        const bs = school && b.text.includes(school) ? 0 : jobName && b.text.includes(jobName) ? 1 : 2;
        return as - bs;
      });
    const match = matches[0];
    if (!match) return { ok: false, reason: 'search_result_not_found', visible: items.slice(0, 12).map(el => (el.innerText || el.textContent || '').trim().slice(0, 100)) };
    match.el.setAttribute('data-boss-auto-thread-result-id', actionId);
    match.el.scrollIntoView({ block: 'center' });
    const r = match.el.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-thread-result-id="' + actionId + '"]', id: match.el.id || '', text: match.text.slice(0, 240), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
  appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "search_thread_result", result: item.ok ? "found" : "not_found", detail: item });
  return item.ok ? { item, search } : { item: null, search, result: item };
}

function scrollChatList(cdp, direction = 1) {
  return cdp.eval(`(() => {
    const direction = ${JSON.stringify(direction)};
    const items = Array.from(document.querySelectorAll('.geek-item'));
    const hasOverflow = el => !!el && el.scrollHeight > el.clientHeight + 20;
    let list = null;
    if (items[0]) {
      for (let p = items[0].parentElement; p && p !== document.body; p = p.parentElement) {
        if (hasOverflow(p)) {
          list = p;
          break;
        }
      }
    }
    if (!list) {
      list = Array.from(document.querySelectorAll('.chat-list, .geek-list, [class*="chat-list"], [class*="geek-list"], [class*="scroll"], [class*="list"]'))
        .filter(hasOverflow)
        .sort((a, b) => {
          const ai = a.querySelectorAll('.geek-item').length;
          const bi = b.querySelectorAll('.geek-item').length;
          if (bi !== ai) return bi - ai;
          return (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight);
        })[0];
    }
    list = list || document.scrollingElement;
    if (!list) return { moved: false, reason: 'list_not_found' };
    const beforeTop = list.scrollTop;
    const beforeHeight = list.scrollHeight;
    const itemCount = list.querySelectorAll ? list.querySelectorAll('.geek-item').length : 0;
    const delta = Math.max(360, Math.floor((list.clientHeight || 500) * 0.85)) * (direction < 0 ? -1 : 1);
    list.scrollBy({ top: delta, behavior: 'auto' });
    return { moved: list.scrollTop !== beforeTop || list.scrollHeight !== beforeHeight, beforeTop, afterTop: list.scrollTop, beforeHeight, afterHeight: list.scrollHeight, clientHeight: list.clientHeight, itemCount, className: String(list.className || '').slice(0, 120) };
  })()`);
}

function resetChatListToTop(cdp) {
  return cdp.eval(`(() => {
    const items = Array.from(document.querySelectorAll('.geek-item'));
    const hasOverflow = el => !!el && el.scrollHeight > el.clientHeight + 20;
    let list = null;
    if (items[0]) {
      for (let p = items[0].parentElement; p && p !== document.body; p = p.parentElement) {
        if (hasOverflow(p)) {
          list = p;
          break;
        }
      }
    }
    list = list || document.querySelector('.user-list.b-scroll-stable, .chat-list, .geek-list, [class*="chat-list"], [class*="geek-list"]') || document.scrollingElement;
    if (!list) return { ok: false, reason: 'list_not_found' };
    const beforeTop = list.scrollTop;
    list.scrollTop = 0;
    return { ok: true, beforeTop, afterTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
  })()`);
}

function findVisibleThread(cdp, target, options) {
  const reset = resetChatListToTop(cdp);
  appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "reset_chat_list", result: reset.ok ? "ok" : "failed", detail: reset });
  sleepMs(300);
  const maxRounds = Math.max(Number(options.maxListScrollRounds) || 0, 30);
  for (let round = 0; round <= maxRounds; round++) {
    const visible = getVisibleItems(cdp);
    const item = visible.find(v =>
      v.text.includes(target.name) &&
      (!target.school || v.text.includes(target.school) || v.text.includes(target.jobName || ""))
    ) || visible.find(v => v.text.includes(target.name));
    if (item) return { item, round };
    if (round >= maxRounds) break;
    const moved = scrollChatList(cdp);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "scroll_chat_list", result: moved.moved ? "moved" : "not_moved", round: round + 1, detail: moved });
    if (!moved.moved) break;
    sleepMs(700 + Math.floor(Math.random() * 400));
  }
  return { item: null, round: maxRounds };
}

function probeAttachment(cdp, name) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const conv = document.querySelector('.chat-conversation');
    const text = (conv?.innerText || '').trim();
    const identity = text.includes(name);
    const hasRequest = /对方想发送附件简历给您，您是否同意/.test(text);
    const hasPreview = /点击预览附件简历|附件简历\.(pdf|doc|docx)|简历\.pdf|简历\.doc|简历\.docx/.test(text);
    const acceptBtns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /^同意$|^接收$/.test((el.innerText || el.textContent || '').trim()) && !String(el.className).includes('disabled'));
    const previewBtns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /点击预览附件简历|预览简历/.test((el.innerText || el.textContent || '').trim()));
    return {
      identity,
      text: text.slice(0, 900),
      hasRequest,
      hasPreview,
      acceptCount: acceptBtns.length,
      acceptSelector: acceptBtns[0] ? acceptBtns[0].id ? '#' + CSS.escape(acceptBtns[0].id) : '' : '',
      previewSelector: previewBtns[0] ? previewBtns[0].id ? '#' + CSS.escape(previewBtns[0].id) : '' : '',
    };
  })()`);
}

function threadIdentityStillMatches(cdp, name) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const visibleText = el => (el?.innerText || el?.textContent || '').trim();
    const selected = Array.from(document.querySelectorAll('.geek-item.selected, .geek-item.active, [class*="selected"], [class*="active"]'))
      .map(visibleText)
      .find(t => t.includes(name));
    const header = Array.from(document.querySelectorAll('[class*="header"], [class*="title"], [class*="name"], .chat-container-private'))
      .map(visibleText)
      .find(t => t.includes(name));
    const bodyHasName = (document.body.innerText || '').includes(name);
    return { ok: !!(selected || header || bodyHasName), selected: !!selected, header: !!header, bodyHasName };
  })()`);
}

function clickFirstAccept(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const btns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /^同意$|^接收$/.test((el.innerText || el.textContent || '').trim()) && !String(el.className).includes('disabled'));
    if (!btns.length) return { ok: false, reason: 'no_accept_button' };
    const btn = btns[0];
    btn.scrollIntoView({ block: 'center' });
    btn.setAttribute('data-boss-auto-action', 'accept-resume');
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-action="accept-resume"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
}

function clickPreview(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const root = conv || document;
    const actionId = 'preview-resume-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-action="preview-resume"], [data-boss-auto-action-id]').forEach(el => {
      el.removeAttribute('data-boss-auto-action');
      el.removeAttribute('data-boss-auto-action-id');
    });
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => (el.innerText || el.textContent || '').trim();
    const nodes = Array.from(root.querySelectorAll('button, a, div, span, p, i, [role="button"]')).filter(visible);
    const exact = nodes
      .filter(el => textOf(el) === '点击预览附件简历')
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0];
    const fileNode = !exact ? nodes
      .filter(el => /^.{1,120}\\.(pdf|doc|docx)$/i.test(textOf(el)))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0] : null;
    const leaf = exact || fileNode;
    if (!leaf) return { ok: false, reason: 'no_precise_preview_node', sample: nodes.slice(-20).map(el => textOf(el).slice(0, 60)).filter(Boolean) };
    let btn = leaf;
    for (let p = leaf; p && p !== root; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      const role = p.getAttribute?.('role') || '';
      const cls = String(p.className || '');
      const tag = p.tagName;
      const clickable = /^(BUTTON|A)$/i.test(tag) || role === 'button' || /file|resume|attachment|preview|card|message|bubble/i.test(cls) || p.onclick;
      if (clickable && r.width > 0 && r.height > 0 && r.width < 420 && r.height < 180) {
        btn = p;
        break;
      }
    }
    btn.scrollIntoView({ block: 'center' });
    btn.setAttribute('data-boss-auto-action', 'preview-resume');
    btn.setAttribute('data-boss-auto-action-id', actionId);
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-action-id="' + actionId + '"]', leafText: textOf(leaf), targetText: textOf(btn).slice(0, 120), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
}

function scrollConversationToBottom(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const candidates = [conv, conv?.parentElement, document.querySelector('[class*="message-list"], [class*="conversation"], [class*="scroll"]'), document.scrollingElement].filter(Boolean);
    const target = candidates.find(el => el.scrollHeight > el.clientHeight + 20) || conv || document.scrollingElement;
    if (!target) return { ok: false, reason: 'no_conversation_scroll_target' };
    const beforeTop = target.scrollTop || 0;
    target.scrollTop = target.scrollHeight;
    return { ok: true, beforeTop, afterTop: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
  })()`);
}

function ensurePreviewOpen(cdp, options) {
  const readPreviewState = () => cdp.eval(`(() => {
      const text = document.body.innerText || '';
      const activeDialog = document.querySelector('.dialog-wrap.active, .boss-dialog__wrapper.resume-common-dialog, .resume-common-dialog.search-resume, .resume-common-wrap, .new-resume-online-main-ui');
      const hasToolbarDownload = !!Array.from(document.querySelectorAll('.attachment-resume-btns *, .resume-footer-wrap *, .dialog-wrap.active *, .boss-dialog__wrapper *'))
        .find(el => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width <= 0 || r.height <= 0) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const t = (el.innerText || el.textContent || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '').trim();
          return t === '下载' || /download/i.test(String(el.className || ''));
        });
      const hasPreviewLayer = !!activeDialog || (hasToolbarDownload && /下载/.test(text) && (/附件简历|简历|pdf|doc/i.test(text) || !!document.querySelector('iframe, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]')));
      const conv = document.querySelector('.chat-conversation');
      const hasPreviewButton = !!Array.from((conv || document).querySelectorAll('button, a, div, span, [class*="file"], [class*="resume"], [class*="attachment"]'))
        .find(el => {
          const t = (el.innerText || el.textContent || '').trim();
          return t === '点击预览附件简历' || /^.{1,120}\\.(pdf|doc|docx)$/i.test(t);
        });
      return { hasPreviewLayer, hasPreviewButton, hasToolbarDownload, activeDialog: !!activeDialog, text: text.slice(0, 500) };
    })()`);
  for (let i = 0; i < 4; i++) {
    const state = readPreviewState();
    if (state.hasPreviewLayer) return { ok: true, alreadyOpen: true, state };
    if (!state.hasPreviewButton) return { ok: false, reason: 'preview_button_not_found_after_accept', state };
    const preview = clickPreview(cdp);
    appendLog(options.logFile, options.runId, MODE, { action: "open_preview", result: preview.ok ? "clicked" : "failed", detail: preview });
    if (preview.ok && preview.selector) {
      cdp.clickAt(preview.selector);
      sleepMs(1600);
      const afterClickState = readPreviewState();
      if (afterClickState.hasPreviewLayer) return { ok: true, alreadyOpen: false, state: afterClickState };
    } else {
      return { ok: false, reason: preview.reason || 'preview_click_failed', state };
    }
  }
  const finalState = readPreviewState();
  if (finalState.hasPreviewLayer) return { ok: true, alreadyOpen: false, state: finalState };
  return { ok: false, reason: 'preview_open_timeout', state: finalState };
}

function clickDownloadInPreview(cdp) {
  return cdp.eval(`(() => {
    document.querySelectorAll('[data-boss-auto-action="download-resume"], [data-boss-auto-download-id]').forEach(el => {
      el.removeAttribute('data-boss-auto-action');
      el.removeAttribute('data-boss-auto-download-id');
    });
    const actionId = 'download-resume-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (_) {}
    }
    const all = [];
    const walk = root => {
      if (!root) return;
      const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('button, a, div, span, i, svg, [role="button"], [class*="download"], [class*="Download"], [title], [aria-label]')) : [];
      for (const node of nodes) {
        all.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    docs.forEach(walk);
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const label = el => [
      el.innerText,
      el.textContent,
      el.getAttribute?.('title'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('data-title'),
      el.className,
      el.id,
    ].filter(Boolean).join(' ');
    const previewText = (document.body.innerText || '').slice(0, 1200);
    const inActivePreview = el => !!el.closest?.('.dialog-wrap.active, .boss-dialog__wrapper, .resume-common-dialog, .search-resume, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]');
    const candidates = all
      .filter(visible)
      .filter(el => /下载|download|down-load/i.test(label(el)))
      .map(el => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').trim();
        const cls = String(el.className || '');
        const score =
          (text === '下载' ? 0 : 20) +
          (/icon-content|download|toolbar|attachment-resume-btns/i.test(cls) ? 0 : 10) +
          (inActivePreview(el) ? 0 : 30) +
          (r.width <= 80 && r.height <= 60 ? 0 : 80) +
          (r.y <= 80 ? 0 : 10) +
          (r.width * r.height) / 10000;
        return { el, r, text, score };
      })
      .sort((a, b) => a.score - b.score);
    const btn = candidates[0]?.el;
    if (!btn) return { ok: false, reason: 'no_download_button', previewText, candidates: all.filter(visible).slice(0, 30).map(el => label(el).slice(0, 80)) };
    btn.setAttribute('data-boss-auto-action', 'download-resume');
    btn.setAttribute('data-boss-auto-download-id', actionId);
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-download-id="' + actionId + '"]', text: label(btn).slice(0, 120), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, score: candidates[0]?.score };
  })()`);
}

function closePreview(cdp) {
  return cdp.eval(`(() => {
    const closeBtn = document.querySelector('.preview-close, [class*="close"], [class*="Close"], .dialog-close, .modal-close');
    if (closeBtn) {
      closeBtn.click();
      return { ok: true, method: 'close_button' };
    }
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
    document.dispatchEvent(escEvent);
    return { ok: true, method: 'escape_key' };
  })()`);
}

function setDownloadDir(proxy, target, dir) {
  try {
    const info = requestJson("GET", `${proxy}/info?target=${target}`);
    const browserContextId = info.browserContextId;
    if (!browserContextId) return { ok: false, reason: "no_browser_context_id" };
    const body = JSON.stringify({ method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: dir, browserContextId } });
    requestJson("POST", `${proxy}/cdp?target=${target}`, body);
    return { ok: true };
  } catch (e) {
    try {
      const body2 = JSON.stringify({ method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: dir } });
      requestJson("POST", `${proxy}/cdp?target=${target}`, body2);
      return { ok: true };
    } catch (e2) {
      return { ok: false, reason: "cdp_set_download_behavior_failed" };
    }
  }
}

function dirSnapshot(dir) {
  if (!fs.existsSync(dir)) return new Map();
  const map = new Map();
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    map.set(fp, { mtime: st.mtimeMs, size: st.size });
  }
  return map;
}

function findNewDownload(dir, beforeSnapshot, afterTime, pollIntervalMs, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastCandidates = new Map();
  while (Date.now() < deadline) {
    const candidates = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(crdownload|tmp|part)$/i.test(f)) continue;
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < afterTime - 2000) continue;
        if (beforeSnapshot.has(fp) && beforeSnapshot.get(fp).mtime === st.mtimeMs && beforeSnapshot.get(fp).size === st.size) continue;
        candidates.push({ path: fp, size: st.size, mtime: st.mtimeMs });
      }
    }
    const stable = candidates.filter(c => {
      const prev = lastCandidates.get(c.path);
      return prev && prev.size === c.size && prev.mtime === c.mtime;
    });
    if (stable.length > 0) {
      stable.sort((a, b) => b.mtime - a.mtime);
      return { ok: true, filePath: stable[0].path, size: stable[0].size };
    }
    for (const c of candidates) lastCandidates.set(c.path, c);
    sleepMs(pollIntervalMs);
  }
  return { ok: false, reason: "download_timeout" };
}

function makeResumeFilename(jobName, name, school, ext) {
  const j = safeFilename(jobName);
  const n = safeFilename(name);
  const s = safeFilename(school);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return s ? `${j}_${n}_${s}_${date}.${ext}` : `${j}_${n}_${date}.${ext}`;
}

function resolveUniquePath(dir, filename) {
  let fp = path.join(dir, filename);
  if (!fs.existsSync(fp)) return fp;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let idx = 1;
  while (idx < 1000) {
    fp = path.join(dir, `${base}_${idx}${ext}`);
    if (!fs.existsSync(fp)) return fp;
    idx++;
  }
  const hash = Math.random().toString(36).slice(2, 6);
  return path.join(dir, `${base}_${hash}${ext}`);
}

function main() {
  const options = loadOptions();
  if (options.selfCheck) {
    _main(options);
    return;
  }

  ensureDir(options.lockDir ? path.dirname(options.lockDir) : null);

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
  const targets = getCollectTargets(candidates, options.maxCollectPerRun, options.jobName);

  if (options.selfCheck) {
    console.log(JSON.stringify({
      status: "ok",
      script: "collect_visible_resumes",
      job_name: options.jobName,
      collect_targets: targets.length,
      dry_run_supported: true,
    }));
    return;
  }

  const cdp = makeClient({ proxy: options.proxy, target: options.target });
  const health = pageHealth(cdp);
  if (health.loginExpired || health.captcha || !health.hasChatList) {
    const reason = health.captcha ? "paused_captcha_detected" : "paused_login_required";
    console.log(JSON.stringify({ status: "paused", reason, mode: MODE, target: cdp.target }));
    return;
  }

  ensureDir(options.resumeDownloadDir);
  let downloadDirSet = false;
  if (!options.dryRun) {
    const dirResult = setDownloadDir(options.proxy, cdp.target, options.resumeDownloadDir);
    downloadDirSet = dirResult.ok;
    if (!dirResult.ok) {
      appendLog(options.logFile, options.runId, MODE, { action: "set_download_dir", result: "failed", error: dirResult.reason });
    }
  }

  let scanned = 0;
  let received = 0;
  let downloaded = 0;
  let queued = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let pausedReason = null;
  let healthCounter = 0;
  let batch = [];

  for (const target of targets) {
    if (pausedReason) break;

    if (healthCounter >= options.healthCheckEveryCandidates) {
      healthCounter = 0;
      const h = pageHealth(cdp);
      if (h.captcha) { pausedReason = "paused_captcha_detected"; break; }
      if (h.loginExpired) { pausedReason = "paused_login_required"; break; }
    }

    const foundBySearch = searchThreadByName(cdp, target, options);
    const found = foundBySearch.item ? foundBySearch : findVisibleThread(cdp, target, options);
    const item = found.item;
    if (!item) {
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "open_thread", result: "skipped", error_code: "candidate_not_visible_after_scroll" });
      skipped++;
      continue;
    }

    if (!options.dryRun) {
      cdp.clickAt(item.selector);
      sleepMs(800 + Math.floor(Math.random() * 400));
    }

    const probe = options.dryRun
      ? { identity: true, hasRequest: false, hasPreview: false, acceptCount: 0 }
      : probeAttachment(cdp, target.name);

    scanned++;
    healthCounter++;

    if (!probe.identity) {
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "identity_check", result: "failed" });
      skipped++;
      continue;
    }

    const c = candidates[target.id] || {};

    if (target.status === "resume_downloaded" && target.localResumePath && target.resumeHash) {
      if (target.status !== "ready_for_hire_sync" && target.status !== "boss_completed") {
        const queueOk = writeSyncQueue(options, target.id, c.name, c.school, target.localResumePath, target.resumeHash);
        if (queueOk) {
          candidates[target.id] = { ...c, status: "ready_for_hire_sync", sync_queue_status: "pending", ready_for_hire_sync_at: now(), last_observation: "sync_queue_written" };
          queued++;
          batch.push(target.id);
        } else {
          candidates[target.id] = { ...c, status: "sync_queue_failed", last_observation: "sync_queue_write_failed", last_error: "sync_queue_write_failed" };
          failed++;
          pausedReason = "paused_sync_queue_write_failed";
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: "failed" });
          break;
        }
      }
      if (target.status !== "boss_completed") {
        const replyResult = options.dryRun ? { ok: true, dryRun: true } : sendConfirmReply(cdp, options);
        if (replyResult.ok) {
          candidates[target.id] = { ...candidates[target.id], status: "boss_completed", boss_completed_at: now(), last_observation: "boss_completed" };
          completed++;
        } else {
          candidates[target.id] = { ...candidates[target.id], status: "paused_send_failed", last_observation: "confirm_reply_failed", last_error: replyResult.reason || "confirm_reply_failed" };
          pausedReason = "paused_send_failed";
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "failed", detail: replyResult });
          break;
        }
      }
      continue;
    }

    if (!probe.hasRequest && !probe.hasPreview && !probe.acceptCount) {
      candidates[target.id] = { ...c, last_observation: "no_attachment_yet", history: [...(c.history || []), { at: now(), run_id: options.runId, action: "collect_probe", result: "no_attachment_yet" }] };
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "collect_probe", result: "no_attachment_yet" });
      skipped++;
      continue;
    }

    received++;

    if (options.dryRun) {
      candidates[target.id] = { ...c, status: "attachment_received", last_observation: "dry_run_attachment_detected" };
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "collect", result: "dry_run" });
      continue;
    }

    if (probe.acceptCount > 0) {
      const accept = clickFirstAccept(cdp);
      if (accept.ok && accept.selector) {
        cdp.clickAt(accept.selector);
        sleepMs(1000);
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "accept_attachment", result: "clicked" });
        const scrollResult = scrollConversationToBottom(cdp);
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "scroll_conversation_bottom", result: scrollResult.ok ? "ok" : "failed", detail: scrollResult });
        sleepMs(400);
      }
    }

    const afterAcceptProbe = probeAttachment(cdp, target.name);
    const afterAcceptIdentity = afterAcceptProbe.identity ? { ok: true, conversation: true } : threadIdentityStillMatches(cdp, target.name);
    if (!afterAcceptIdentity.ok) {
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "identity_check_after_accept", result: "failed", detail: afterAcceptIdentity });
      skipped++;
      continue;
    }

    const previewOpen = ensurePreviewOpen(cdp, options);
    if (!previewOpen.ok) {
      candidates[target.id] = { ...c, status: "download_failed", last_observation: previewOpen.reason, last_error: previewOpen.reason };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "open_preview", result: "failed", error_code: previewOpen.reason, detail: previewOpen });
      continue;
    }

    const dlBtn = clickDownloadInPreview(cdp);
    if (!dlBtn.ok) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "download_button_not_found", last_error: "download_button_not_found" };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "download_button_not_found", detail: dlBtn });
      continue;
    }

    const beforeSnapshot = dirSnapshot(downloadDirSet ? options.resumeDownloadDir : require("os").homedir() + "/Downloads");
    const clickTime = Date.now();
    cdp.clickAt(dlBtn.selector);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "click_download", result: "clicked", detail: dlBtn });

    const downloadDir = downloadDirSet ? options.resumeDownloadDir : (require("os").homedir() + "/Downloads");
    const dlResult = findNewDownload(downloadDir, beforeSnapshot, clickTime, options.downloadPollIntervalMs, options.downloadMaxWaitSeconds);

    if (!dlResult.ok) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: dlResult.reason, last_error: dlResult.reason };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: dlResult.reason });
      continue;
    }

    const ext = path.extname(dlResult.filePath).toLowerCase() || ".pdf";
    const finalName = makeResumeFilename(options.jobName, target.name, target.school, ext.replace(/^\./, ""));
    const destPath = resolveUniquePath(options.resumeDownloadDir, finalName);

    try {
      if (downloadDirSet) {
        fs.renameSync(dlResult.filePath, destPath);
      } else {
        fs.copyFileSync(dlResult.filePath, destPath);
        fs.unlinkSync(dlResult.filePath);
      }
      const finalStat = fs.statSync(destPath);
      if (!finalStat.isFile() || finalStat.size <= 0) {
        throw new Error("downloaded_file_invalid");
      }
    } catch (e) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "rename_failed", last_error: String(e.message) };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "rename_failed" });
      continue;
    }

    const hash = fileHash(destPath);
    if (!hash || !fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "download_verify_failed", last_error: "download_verify_failed" };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "download_verify_failed", path: destPath });
      continue;
    }
    downloaded++;
    candidates[target.id] = {
      ...c,
      status: "resume_downloaded",
      local_resume_path: destPath,
      resume_hash: hash,
      resume_downloaded_at: now(),
      last_observation: "resume_downloaded",
      history: [...(c.history || []), { at: now(), run_id: options.runId, action: "download_resume", result: "ok" }],
    };
    batch.push(target.id);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download_resume", result: "ok", path: destPath, hash });

    const queueOk = writeSyncQueue(options, target.id, c.name, c.school, destPath, hash);
    if (!queueOk) {
      candidates[target.id] = { ...candidates[target.id], status: "sync_queue_failed", last_observation: "sync_queue_write_failed", last_error: "sync_queue_write_failed" };
      failed++;
      pausedReason = "paused_sync_queue_write_failed";
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: "failed" });
      break;
    }

    queued++;
    candidates[target.id] = { ...candidates[target.id], status: "ready_for_hire_sync", sync_queue_status: "pending", ready_for_hire_sync_at: now(), last_observation: "sync_queue_written" };
    batch.push(target.id);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: "ok" });

    closePreview(cdp);
    sleepMs(500);

    const replyResult = sendConfirmReply(cdp, options);
    if (replyResult.ok) {
      candidates[target.id] = { ...candidates[target.id], status: "boss_completed", boss_completed_at: now(), last_observation: "boss_completed" };
      completed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "ok", detail: replyResult });
    } else {
      candidates[target.id] = { ...candidates[target.id], status: "paused_send_failed", last_observation: "confirm_reply_failed", last_error: replyResult.reason || "confirm_reply_failed" };
      pausedReason = "paused_send_failed";
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "failed", detail: replyResult });
      break;
    }

    if (batch.length >= options.stateFlushBatchSize) {
      saveState(options.stateFile, state, options.jobName);
      batch = [];
    }
  }

  saveState(options.stateFile, state, options.jobName);
  console.log(JSON.stringify({
    status: pausedReason ? "paused" : "ok",
    mode: MODE,
    scanned,
    received,
    downloaded,
    queued,
    completed,
    skipped,
    failed,
    paused_reason: pausedReason,
    run_id: options.runId,
    target: cdp.target,
  }));
}

function writeSyncQueue(options, candidateId, name, school, localPath, hash) {
  try {
    const record = {
      candidate_id: candidateId,
      name: name || "",
      school: school || "",
      job_name: options.jobName,
      filename: path.basename(localPath),
      local_resume_path: localPath,
      resume_hash: hash,
      sync_queue_status: "pending",
      boss_status: "boss_completed",
      ready_for_hire_sync_at: now(),
    };
    ensureDir(options.syncQueueFile ? path.dirname(options.syncQueueFile) : null);
    fs.appendFileSync(options.syncQueueFile, JSON.stringify(record) + "\n");
    return true;
  } catch (e) {
    return false;
  }
}

function sendConfirmReply(cdp, options) {
  try {
    const prepared = cdp.eval(`(() => {
      const message = ${JSON.stringify(options.confirmReceivedMessage)};
      const actionId = 'confirm-send-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      document.querySelectorAll('[data-boss-auto-confirm-send-id]').forEach(el => el.removeAttribute('data-boss-auto-confirm-send-id'));
      const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
      if (!editor) return { ok: false, reason: 'editor_not_found' };
      editor.focus();
      editor.innerHTML = '';
      editor.textContent = message;
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: message }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      const btns = Array.from(document.querySelectorAll('.chat-container-private .submit, .chat-input .submit, .submit, button, [role="button"]'))
        .filter(el => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width <= 0 || r.height <= 0) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
          const t = (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim();
          return /发送/.test(t) || String(el.className || '').includes('submit');
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const as = String(a.className || '').includes('submit') ? 0 : 10;
          const bs = String(b.className || '').includes('submit') ? 0 : 10;
          if (as !== bs) return as - bs;
          return br.x - ar.x;
        });
      const btn = btns[0];
      if (!btn) return { ok: false, reason: 'send_button_not_found', editorText: (editor.innerText || editor.textContent || '').trim() };
      btn.setAttribute('data-boss-auto-confirm-send-id', actionId);
      const r = btn.getBoundingClientRect();
      return { ok: true, selector: '[data-boss-auto-confirm-send-id="' + actionId + '"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, editorText: (editor.innerText || editor.textContent || '').trim() };
    })()`);
    if (!prepared.ok || !prepared.selector) return prepared;
    cdp.clickAt(prepared.selector);
    sleepMs(Math.max(Number(options.confirmTimeoutMs) || 0, 1200));
    const check = cdp.eval(`(() => {
      const message = ${JSON.stringify(options.confirmReceivedMessage)};
      const conv = document.querySelector('.chat-conversation');
      const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
      const editorText = (editor?.innerText || editor?.textContent || '').trim();
      const convText = (conv?.innerText || '').trim();
      return {
        ok: convText.includes(message) && !editorText.includes(message),
        messageInConversation: convText.includes(message),
        editorCleared: !editorText.includes(message),
        editorText: editorText.slice(0, 120),
      };
    })()`);
    if (!check.ok) {
      if (check.messageInConversation && !check.editorCleared) {
        const cleared = cdp.eval(`(() => {
          const message = ${JSON.stringify(options.confirmReceivedMessage)};
          const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
          if (!editor) return { ok: false, reason: 'editor_not_found' };
          const editorText = (editor.innerText || editor.textContent || '').trim();
          if (!editorText.includes(message)) return { ok: true, alreadyCleared: true };
          editor.focus();
          editor.innerHTML = '';
          editor.textContent = '';
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, clearedDraft: true };
        })()`);
        if (cleared.ok) return { ok: true, prepared, check, clearedDraft: cleared };
      }
      return { ok: false, reason: check.messageInConversation ? 'confirm_editor_not_cleared' : 'confirm_message_not_in_conversation', prepared, check };
    }
    return { ok: true, prepared, check };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

main();
