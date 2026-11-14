'use strict';

(() => {
  const storageKey = 'seeker_provider_retry_v1';
  const limits = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (Number.isFinite(value.until) && value.until > Date.now() && typeof value.message === 'string') limits.set(key, value);
    }
  } catch (_) {}

  function messageFrom(value) {
    if (typeof value === 'string') {
      try { return messageFrom(JSON.parse(value)); } catch (_) { return value; }
    }
    if (!value || typeof value !== 'object') return '';
    for (const key of ['error', 'message', 'detail', 'title']) {
      const text = messageFrom(value[key]);
      if (text) return text;
    }
    return '';
  }

  function retryAt(text, retryAfter, now) {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const timestamp = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : Date.parse(retryAfter);
      if (Number.isFinite(timestamp) && timestamp > now) return timestamp;
    }
    const clock = text.match(/(?:try again|retry|resets?)\s+(?:in|after)\s+(\d{1,3}):(\d{2}):(\d{2})/i);
    if (clock && Number(clock[2]) < 60 && Number(clock[3]) < 60) {
      return now + (Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) * 1000;
    }
    const seconds = text.match(/(?:try again|retry|resets?)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
    if (seconds) return now + Number(seconds[1]) * (/^(?:h)/i.test(seconds[2]) ? 3600000 : /^(?:m)/i.test(seconds[2]) ? 60000 : 1000);
    return null;
  }

  function failure(raw, label, status, retryAfter) {
    const text = messageFrom(raw).replace(/\s+/g, ' ').trim();
    let kind = 'provider', message;
    if (/illegal duration|requested GPU duration.{0,100}(?:larger|exceed)|duration.{0,50}(?:maximum allowed|per.call)/i.test(text)) {
      kind = 'duration';
      message = label + ' requested more GPU time than this provider session allows. Waiting alone may not fix this. Try a smaller request or use a local storyboard.';
    } else if (/quota.{0,50}(?:exceed|exhaust|insufficient)|exceeded.{0,50}quota|GPU limit|remaining.{0,30}quota/i.test(text)) {
      kind = 'quota';
      message = label + ' reached the provider’s free GPU allowance. Wait for its reset before submitting another job.';
    } else if (status === 429 || /too many requests|rate limit/i.test(text)) {
      kind = 'rate';
      message = label + ' is rate limiting requests. Wait before submitting another job.';
    } else if (/queue.{0,30}(?:full|timeout)|no GPU.{0,30}available/i.test(text)) {
      kind = 'busy';
      message = label + ' could not get a free GPU slot. Try again later.';
    } else if ([401, 403].includes(status)) {
      kind = 'access';
      message = label + ' denied access to this session (HTTP ' + status + ').';
    } else {
      message = label + (text && text !== 'null' ? ' reported an error. ' + text.replace(/https?:\/\/\S+/g, '[provider link]').slice(0, 350) : ' ended without a result. The demo did not explain the failure.');
      if (status) message += ' HTTP ' + status + '.';
    }
    const error = new Error(message);
    error.kind = kind;
    error.retryAt = ['quota', 'rate', 'busy'].includes(kind) ? retryAt(text, retryAfter, Date.now()) : null;
    if (error.retryAt) error.message += ' Retry after ' + new Date(error.retryAt).toLocaleTimeString() + ' (provider supplied).';
    if (['quota', 'duration', 'rate'].includes(kind)) error.message += ' This limit comes from the audio/video provider.';
    return error;
  }

  async function check(response, label) {
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    throw failure(body, label, response.status, response.headers?.get('retry-after'));
  }

  function result(events, label) {
    const frames = events.split(/\r?\n\r?\n/).map(block => ({
      type: block.match(/^event:\s*(\S+)/m)?.[1],
      data: [...block.matchAll(/^data:\s?(.*)$/gm)].map(match => match[1]).join('\n')
    }));
    const completed = frames.findLast(frame => frame.type === 'complete');
    if (completed && completed.data && completed.data !== 'null') {
      try { return JSON.parse(completed.data); } catch (_) { throw failure('The result format could not be read.', label); }
    }
    const error = frames.findLast(frame => frame.type === 'error');
    let detail = error?.data;
    if (!messageFrom(detail)) {
      detail = frames.findLast(frame => /quota|illegal duration|rate limit|GPU limit/i.test(messageFrom(frame.data)))?.data;
    }
    throw failure(detail, label);
  }

  function pause(error, key) {
    if (!error.retryAt || error.retryAt <= Date.now()) return;
    limits.set(key, { until: error.retryAt, message: error.message });
    try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(limits))); } catch (_) {}
  }

  function blocked(key) {
    const limit = limits.get(key);
    return limit?.until > Date.now() ? limit.message : '';
  }

  function watch({ key, busy, button, note }) {
    const refresh = () => {
      const message = blocked(key());
      note.textContent = message;
      note.classList.toggle('hidden', !message);
      button.disabled = busy() || Boolean(message);
    };
    setInterval(refresh, 1000);
    refresh();
    return refresh;
  }

  globalThis.SeekerProvider = { failure, check, result, pause, blocked, watch };
})();
