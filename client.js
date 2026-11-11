/*
 * Client half of @iasiv5/dsh-send-later.
 * Adds a clock button before the composer's submit action. The popover asks for a delay
 * or a local time plus a message, then asks the Host Schedule service to deliver that
 * message to the current session as a one-shot task. Pending sends for this session are
 * listed in the panel and can be cancelled; the button shows a count badge. The panel stays
 * open after a successful schedule — the confirmation and the fresh row live in it, so closing
 * it is always the user's call. No delivery logic lives here — the Host Schedule service owns
 * persistence and delivery; the only client timer is the one-shot fresh-row highlight.
 */
window.__ModuleLoader__.load({
  id: 'dsh-send-later',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'send-later';
    const STORE_PENDING = 'dsh-send-later:v1:pending';
    const STORE_PROMPT = 'dsh-send-later:v1:prompt';
    const STORE_PRESET = 'dsh-send-later:v1:preset';
    const STORE_SNIPPETS = 'dsh-send-later:v1:snippets';
    const STORE_NUDGES = 'dsh-send-later:v1:nudges';
    // Watchdog cadence: first nudge once a send is 5 minutes past due, then every 10 minutes,
    // at most 3 automatic nudges per task. Manual redelivery stays in the official page.
    const NUDGE_GRACE_MS = 5 * 60000;
    const NUDGE_GAP_MS = 10 * 60000;
    const NUDGE_MAX = 3;
    // A just-created send the catalog does not list yet stays visible this long (Q14): the catalog can lag a create.
    const LAG_WINDOW_MS = 30000;
    // A run-now keeps the one-shot's occurrence on the Host, which delivers it again once the Host's
    // 60 s delivery floor clears. Retiring the task (delete) inside that window prevents the repeat;
    // a failed delete is retried on the cadence below until the window closes.
    const RETIRE_WINDOW_MS = 55000;
    const RETIRE_RETRY_MS = 3000;
    const ARCHIVED_CODE = 'schedule/target-archived';

    const EN = {
      button: 'Send later',
      panelTitle: 'Send later to this session',
      preset10m: '10m',
      preset30m: '30m',
      preset1h: '1h',
      preset5h: '5h',
      presetCustom: 'Custom',
      close: 'Close',
      date: 'Date',
      time: 'Time',
      promptLabel: 'Message',
      promptDefault: 'Continue',
      promptPlaceholder: 'Message to send',
      summaryPrefix: 'Sends at ',
      summarySuffix: ' to this session',
      pendingTitle: 'Pending sends',
      cancel: 'Cancel',
      cancelTask: 'Cancel this send',
      cancelFailed: 'Cancel failed: ',
      submit: 'Schedule',
      busy: 'Scheduling…',
      cancelling: 'Cancelling…',
      donePrefix: 'Scheduled for ',
      doneSuffix: '',
      titlePrefix: 'Send later: ',
      errEmpty: 'The message cannot be empty.',
      errPast: 'Choose a time at least one minute ahead.',
      errNoSession: 'No session is available.',
      errFailed: 'Scheduling failed: ',
      errDisabled: 'Send later is unavailable: the Automation tasks feature is disabled.',
      relSoon: '<1m',
      relMin: 'in {m}m',
      relHour: 'in {h}h',
      relHourMin: 'in {h}h{m}m',
      relDay: 'in {d}d',
      snipResumeLabel: 'Safe resume',
      snipResumeText: 'Resume from where you left off; do not start unrelated new work.',
    };

    const ZH = {
      button: '延时发送',
      panelTitle: '延时发送到本会话',
      preset10m: '10 分',
      preset30m: '30 分',
      preset1h: '1 时',
      preset5h: '5 时',
      presetCustom: '指定',
      close: '关闭',
      date: '日期',
      time: '时间',
      promptLabel: '发送内容',
      promptDefault: '继续',
      promptPlaceholder: '要发送的内容',
      summaryPrefix: '将于 ',
      summarySuffix: ' 发送到本会话',
      pendingTitle: '待发送',
      cancelTask: '取消这条发送',
      cancelFailed: '取消失败：',
      cancel: '取消',
      submit: '排程',
      busy: '排程中…',
      cancelling: '取消中…',
      donePrefix: '已排程，',
      doneSuffix: ' 发送',
      titlePrefix: '延时发送：',
      errEmpty: '发送内容不能为空。',
      errPast: '请选择至少一分钟之后的时间。',
      errNoSession: '当前没有可用的会话。',
      errFailed: '排程失败：',
      errDisabled: '延时发送不可用：自动化任务（排程）功能未启用。',
      relSoon: '1分钟内',
      relMin: '{m}分钟后',
      relHour: '{h}时后',
      relHourMin: '{h}时{m}分后',
      relDay: '{d}天后',
      snipResumeLabel: '安全继续',
      snipResumeText: '从中断处继续，不要开始与目标无关的新工作。',
    };
    // Title markers a task may carry: every built-in language's prefix, so a device adopts sends that were
    // created in another UI language (Q2). Derived from the dictionaries, never hand-maintained.
    const TITLE_MARKERS = [EN.titlePrefix, ZH.titlePrefix];

    const PRESETS = [
      { id: '10m', seconds: 600, label: 'preset10m' },
      { id: '30m', seconds: 1800, label: 'preset30m' },
      { id: '1h', seconds: 3600, label: 'preset1h' },
      { id: '5h', seconds: 18000, label: 'preset5h' },
      { id: 'custom', seconds: 0, label: 'presetCustom' },
    ];

    const fallbackDict = /^zh/i.test(navigator.language || '') ? ZH : EN;
    const fallbackT = (key) => (fallbackDict[key] !== undefined ? fallbackDict[key] : (EN[key] !== undefined ? EN[key] : key));

    /** One-shot stylesheet for the fresh-row highlight; keyed by id so re-apply is free. */
    function ensureFlashStyles() {
      try {
        if (document.getElementById('dsh-send-later-flash')) return;
        const style = document.createElement('style');
        style.id = 'dsh-send-later-flash';
        style.textContent = '@keyframes send-later-flash{from{background:var(--dsw-alias-interactive-bg-active)}to{background:var(--dsw-alias-bg-layer-1)}}';
        document.head.appendChild(style);
      } catch (_error) { /* cosmetic only; the panel works without it */ }
    }

    const pad = (n) => String(n).padStart(2, '0');
    const dateValue = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeValue = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const compactWhen = (d) => (d.getTime() - Date.now() > 86400000 ? `${dateValue(d).slice(5)} ${timeValue(d)}` : timeValue(d));

    /** Pending rows show a relative label ("in 10 min"); the absolute time rides on the title attribute. */
    function relativeWhen(when, t) {
      const d = when instanceof Date ? when : new Date(when);
      const absolute = `${dateValue(d)} ${timeValue(d)}`;
      const diff = d.getTime() - Date.now();
      if (!Number.isFinite(diff) || diff < 0) return { label: absolute, absolute };
      const minutes = Math.round(diff / 60000);
      if (minutes < 1) return { label: t('relSoon'), absolute };
      if (minutes < 60) return { label: t('relMin').replace('{m}', String(minutes)), absolute };
      const hours = Math.floor(minutes / 60);
      if (hours >= 24) return { label: t('relDay').replace('{d}', String(Math.floor(hours / 24))), absolute };
      return minutes % 60 === 0
        ? { label: t('relHour').replace('{h}', String(hours)), absolute }
        : { label: t('relHourMin').replace('{h}', String(hours)).replace('{m}', String(minutes % 60)), absolute };
    }

    function parseLocal(date, time) {
      const [year, month, day] = String(date).split('-').map(Number);
      const [hour, minute] = String(time).split(':').map(Number);
      if ([year, month, day, hour, minute].some((value) => !Number.isInteger(value))) return undefined;
      const when = new Date(year, month - 1, day, hour, minute, 0, 0);
      return Number.isNaN(when.getTime()) ? undefined : when;
    }

    /**
     * Official theme paints brand-primary as the neutral ink statics; skins themes paint their own
     * accent. Comparing the computed value against the ink statics tells the two apart, so the
     * submit button can be solid under the official theme and tonal under skins themes.
     */
    function detectSolidAccent() {
      try {
        const cs = getComputedStyle(document.body);
        const read = (n) => cs.getPropertyValue(n).trim().toLowerCase();
        const primary = read('--dsw-alias-brand-primary');
        if (primary === '') return false;
        const inkDark = read('--dsw-static-neutral-bluish-1000');
        const inkLight = read('--dsw-static-neutral-bluish-50');
        return (inkDark !== '' && primary === inkDark) || (inkLight !== '' && primary === inkLight);
      } catch (_error) {
        return false;
      }
    }

    /** GLM 5h window from the quota-watch snapshot; null when the plugin or the window is absent. */
    async function fetchGlm5hQuota() {
      try {
        const res = await fetch('/api/dsh-quota-watch/overview', { headers: { accept: 'application/json' } });
        if (!res || !res.ok) return null;
        const data = await res.json();
        const providers = Array.isArray(data?.providers) ? data.providers : [];
        const glm = providers.find((p) => p && p.key === 'glm' && p.status === 'ready')
          ?? providers.find((p) => typeof p?.providerId === 'string' && p.providerId.startsWith('zai'));
        const window5h = glm?.plan?.windows?.find((w) => w && w.key === '5h');
        if (!window5h || typeof window5h.resetsAt !== 'string') return null;
        const resetAt = Date.parse(window5h.resetsAt);
        if (!Number.isFinite(resetAt)) return null;
        return { percent: typeof window5h.percent === 'number' ? window5h.percent : undefined, resetAt };
      } catch (_error) {
        return null;
      }
    }

    function browserTimeZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch (_error) {
        return 'UTC';
      }
    }

    function loadStored(key, validate) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return undefined;
        const value = JSON.parse(raw);
        return validate(value) ? value : undefined;
      } catch (_error) {
        return undefined;
      }
    }

    function storeValue(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch (_error) { /* storage unavailable; reminders still work without memory */ }
    }

    /** Pending sends this plugin created, keyed by schedule task id. Best-effort memory. */
    function loadRegistry() {
      return loadStored(STORE_PENDING, (v) => Array.isArray(v))
        ?.filter((e) => e && typeof e.id === 'string' && typeof e.sessionId === 'string') ?? [];
    }

    /** Per-task watchdog bookkeeping: { [taskId]: { count, lastAt, archived? } }. Best-effort memory. */
    function loadNudges() {
      return loadStored(STORE_NUDGES, (v) => v && typeof v === 'object' && !Array.isArray(v)) ?? {};
    }
    /** Pure ledger updates: the caller persists the returned book (Q8). */
    function applyAttempt(book, id, now) {
      const prior = book[id] && typeof book[id] === 'object' ? book[id] : {};
      return { ...book, [id]: { count: (typeof prior.count === 'number' ? prior.count : 0) + 1, lastAt: now } };
    }
    function markArchived(book, id, now) {
      const prior = book[id] && typeof book[id] === 'object' ? book[id] : {};
      return { ...book, [id]: {
        count: typeof prior.count === 'number' ? prior.count : 0,
        lastAt: typeof prior.lastAt === 'number' ? prior.lastAt : now,
        archived: true,
      } };
    }
    /** Pure: the ledger without a retired task's entry (Q24). */
    function forgetNudge(book, id) {
      const next = { ...book };
      delete next[id];
      return next;
    }
    /** Glossary 搁浅: past its target time, no receipt, not in flight. State only, no grace. */
    function isStalled(entry, now) {
      return Boolean(entry && entry.status === 'active'
        && typeof entry.scheduledAt === 'string'
        && !entry.executionActive
        && entry.lastDelivery === undefined
        && Number.isFinite(Date.parse(entry.scheduledAt))
        && Date.parse(entry.scheduledAt) <= now);
    }
    /** Watchdog policy on top of the state: a stalled task only becomes due after the grace window. */
    function pastGrace(entry, now) {
      return Date.parse(entry.scheduledAt) + NUDGE_GRACE_MS <= now;
    }
    /** Owned, stalled, past the grace window and within the budget: the ids to nudge now. */
    function dueNudges({ entries, owned, book, now }) {
      return entries
        .filter((entry) => entry && owned.has(entry.id) && isStalled(entry, now) && pastGrace(entry, now)
          && autoNudgeDue(entry, book, now))
        .map((entry) => entry.id);
    }
    /** Whether the per-task budget allows an automatic nudge right now. */
    function autoNudgeDue(entry, nudges, now) {
      const book = nudges[entry.id];
      if (book && book.archived) return false;
      const count = book && typeof book.count === 'number' ? book.count : 0;
      if (count >= NUDGE_MAX) return false;
      const lastAt = book && typeof book.lastAt === 'number' ? book.lastAt : -Infinity;
      return now - lastAt >= NUDGE_GAP_MS;
    }
    /** An admitted run-now answers with the task itself, carrying the receipt that proves the delivery.
     * A refusal answers with a bare `code` (execution pending, not found): nothing was sent. */
    function isAdmittedRun(value, id) {
      return Boolean(value && typeof value === 'object' && value.id === id && value.code === undefined
        && value.lastDelivery && typeof value.lastDelivery.deliveredAt === 'string');
    }
    const toPendingRow = (r) => ({ id: r.id, at: r.at, prompt: typeof r.prompt === 'string' ? r.prompt : '' });
    /** This session's delayed sends, from the local registry and the catalog. Pure: the caller does the
     * registry write-back and the state update. `owned` holds the catalog ids this session owns (registry
     * id or title marker); a catalog-lag fallback row is shown but never owned. */
    function mergePending({ registry, catalog, sid, markers, now }) {
      if (!Array.isArray(catalog)) {
        // Catalog unavailable: fall back to the local registry so the badge stays honest.
        return { pending: registry.filter((r) => r.sessionId === sid).map(toPendingRow), owned: new Set(), catalogAvailable: false };
      }
      const byId = new Map(catalog.map((entry) => [entry.id, entry]));
      const isOurs = (entry) => entry && entry.status === 'active'
        && entry.target && entry.target.kind === 'session' && entry.target.sessionId === sid;
      const live = [];
      const seen = new Set();
      const owned = new Set();
      for (const r of registry) {
        const entry = byId.get(r.id);
        if (entry && isOurs(entry) && !seen.has(r.id)) {
          live.push({ id: r.id, at: entry.scheduledAt || r.at, prompt: typeof entry.prompt === 'string' ? entry.prompt : r.prompt || '' });
          seen.add(r.id);
          owned.add(r.id);
        }
      }
      // Adopt tasks created elsewhere (another browser or device) that carry our title marker.
      for (const entry of catalog) {
        if (isOurs(entry) && !seen.has(entry.id)
          && typeof entry.title === 'string' && markers.some((marker) => entry.title.startsWith(marker))) {
          live.push({ id: entry.id, at: entry.scheduledAt, prompt: typeof entry.prompt === 'string' ? entry.prompt : '' });
          seen.add(entry.id);
          owned.add(entry.id);
        }
      }
      // A just-created send the catalog does not list yet stays visible for LAG_WINDOW_MS. A send the catalog
      // does know is never shown from the registry alone, so a known ended or moved task drops out (Q14).
      for (const r of registry) {
        if (!seen.has(r.id) && !byId.has(r.id) && r.sessionId === sid
          && typeof r.ts === 'number' && now - r.ts < LAG_WINDOW_MS) {
          live.push({ id: r.id, at: r.at, prompt: typeof r.prompt === 'string' ? r.prompt : '' });
          seen.add(r.id);
        }
      }
      live.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { pending: live, owned, catalogAvailable: true };
    }
    /** The delivery watchdog as one module (Q22). Ports are injected: the catalog and run/delete faces,
     * the ledger writer, the clock, the retry sleep and the panel's liveness. The in-flight set belongs to
     * the instance, so one task is never nudged twice at once. Each started task reports one outcome, and
     * the caller decides whether the list needs a refresh (Q23). */
    function createWatchdog(ports) {
      const inFlight = new Set();

      /** Delete a task whose run-now was admitted. The Host holds its next delivery back for 60 s after
       * the receipt, so failed deletes retry until that window closes. expectedUpdatedAt makes the Host
       * refuse the delete when the task changed since the run. */
      async function retire(id, delivered) {
        const deadline = Date.parse(delivered.lastDelivery.deliveredAt) + RETIRE_WINDOW_MS;
        for (;;) {
          let result;
          try {
            result = await ports.cancelTask(id, delivered.updatedAt);
          } catch (_error) {
            result = undefined;
          }
          if (result && result.ok === true) {
            const code = result.value && result.value.code;
            if (code === undefined || code === 'schedule_not_found') return 'retired';
            if (code === 'schedule_conflict') return 'conflict';
          }
          if (!ports.isAlive() || ports.now() + RETIRE_RETRY_MS > deadline) return 'window-closed';
          await ports.sleep(RETIRE_RETRY_MS);
        }
      }

      /** One due task: re-read the catalog first (never re-run or delete what the Host just delivered),
       * run it, and retire it when the run was admitted. */
      async function nudgeOne(id, state) {
        let ran = false;
        try {
          const result = await ports.listCatalog();
          const entries = result && result.ok ? result.value : undefined;
          const entry = Array.isArray(entries) ? entries.find((candidate) => candidate && candidate.id === id) : undefined;
          const now = ports.now();
          if (!(entry && isStalled(entry, now) && pastGrace(entry, now))) return 'skipped';
          // Q21: the attempt is counted once the re-check says a run is due, and it is persisted before the run.
          // If it cannot be recorded, nothing is sent.
          state.book = applyAttempt(state.book, id, now);
          ports.persistBook(state.book);
          ran = true;
          const outcome = await ports.runTask(id);
          if (outcome && outcome.ok === false && outcome.error && outcome.error.code === ARCHIVED_CODE) {
            state.book = markArchived(state.book, id, ports.now());
            ports.persistBook(state.book);
            return 'archived';
          }
          const admitted = outcome && outcome.ok === true ? outcome.value : undefined;
          if (isAdmittedRun(admitted, id)) {
            const retired = await retire(id, admitted);
            // Q24: a retired task leaves no entry in the ledger.
            if (retired === 'retired') {
              state.book = forgetNudge(state.book, id);
              ports.persistBook(state.book);
            }
            return retired;
          }
          if (admitted && admitted.code !== undefined) return 'refused';
          return 'run-failed';
        } catch (_error) {
          return ran ? 'run-failed' : 'skipped';
        } finally {
          inFlight.delete(id);
        }
      }

      return {
        /** Scan once: start every owned, due task that is not already in flight. `onOutcome(id, outcome)`
         * fires as each one settles; the returned promise resolves with all of them. */
        async scan({ entries, owned, book, onOutcome }) {
          const state = { book };
          const due = dueNudges({ entries, owned, book, now: ports.now() }).filter((id) => !inFlight.has(id));
          const started = due.map((id) => {
            inFlight.add(id);
            return nudgeOne(id, state).then((outcome) => {
              if (onOutcome) onOutcome(id, outcome);
              return { id, outcome };
            });
          });
          return Promise.all(started);
        },
      };
    }

    /** The most recent custom prompt (the strip shows exactly two chips: builtin + this). */
    function loadSnippets() {
      return loadStored(STORE_SNIPPETS, (v) => Array.isArray(v))
        ?.filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, 1) ?? [];
    }

    const S = {
      buttonWrap: { position: 'relative', display: 'inline-flex' },
      button: (open) => ({
        width: 28, height: 28, padding: 0, borderRadius: 8, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: open ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
        color: open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      badge: {
        position: 'absolute', top: -5, right: -5, minWidth: 14, height: 14, padding: '0 4px',
        borderRadius: 7, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-brand-text, var(--dsw-alias-label-primary))',
        fontSize: 10, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
      },
      panel: (anchor) => ({
        position: 'fixed', ...(anchor.narrow
          ? { left: 8, right: 8, bottom: 8, maxHeight: '70vh' }
          : { left: anchor.left, bottom: anchor.bottom, width: anchor.width, maxHeight: anchor.maxHeight }),
        boxSizing: 'border-box', overflowY: 'auto', padding: 10,
        display: 'flex', flexDirection: 'column', gap: 8, borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        fontSize: 13, lineHeight: 1.4, zIndex: 1000,
      }),
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      heading: { fontWeight: 600, fontSize: 13, flexShrink: 0, display: 'inline-flex', alignItems: 'baseline', gap: 5 },
      closeBtn: {
        width: 22, height: 22, padding: 0, borderRadius: 6, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      chips: {
        display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 2, padding: 2,
        borderRadius: 10, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      chip: (on) => ({
        padding: '4px 0', borderRadius: 8, cursor: 'pointer', fontSize: 12, textAlign: 'center',
        border: `1px solid ${on ? 'var(--dsw-alias-border-l2)' : 'transparent'}`,
        background: on ? 'var(--dsw-alias-bg-overlay)' : 'transparent',
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        boxShadow: on ? '0 1px 2px rgba(0, 0, 0, 0.08)' : 'none',
      }),
      row: { display: 'flex', gap: 8 },
      field: {
        display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0,
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
      },
      input: {
        boxSizing: 'border-box', width: '100%', padding: '6px 8px', borderRadius: 8, fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
      },
      summary: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      done: { color: 'var(--dsw-alias-state-success-primary)' },
      fieldRow: { display: 'flex', alignItems: 'center', gap: 8 },
      fieldLabel: { flexShrink: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      snips: { display: 'flex', gap: 6, minWidth: 0, overflow: 'hidden' },
      snipChip: (on, shrink) => ({
        flex: `0 ${shrink ? 1 : 0} auto`, minWidth: shrink ? 0 : undefined, maxWidth: 140,
        padding: '3px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
        display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden',
        whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        // Always filled: a pill with a surface reads as a clickable chip, not as caption text.
        border: `1px solid ${on ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-border-l1)'}`,
        background: on ? 'var(--dsw-alias-interactive-bg-active)' : 'var(--dsw-alias-bg-layer-1)',
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      snipText: { minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pendingList: {
        display: 'flex', flexDirection: 'column', gap: 4,
        borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8,
      },
      pendingLabel: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      pendingRow: {
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      pendingRowFresh: { animation: 'send-later-flash 1.6s ease-out' },
      pendingWhen: { width: 78, flexShrink: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'left', whiteSpace: 'nowrap' },
      pendingText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pendingCancel: {
        flexShrink: 0, width: 22, height: 22, padding: 0, borderRadius: 6, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
      },
      footer: { display: 'flex', alignItems: 'center', gap: 8 },
      secondary: {
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      primary: (solid) => ({
        padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: solid ? '1px solid transparent' : '1px solid var(--dsw-alias-border-l2)',
        opacity: solid ? 1 : 1,
        // Solid under the official theme (its brand accent is ink; use the host's blue like the
        // send button does), tonal under skins themes (their invert tokens are not guaranteed).
        background: solid ? '#4176e6' : 'var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2))',
        color: solid ? '#ffffff' : 'var(--dsw-alias-brand-text, var(--dsw-alias-label-primary))',
      }),
    };

    const clockIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3 2' }));

    const crossIcon = () => h('svg', {
      width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2.4, strokeLinecap: 'round', 'aria-hidden': 'true', focusable: 'false',
    }, h('path', { d: 'M6 6l12 12M18 6L6 18' }));

    const boltIcon = () => h('svg', {
      width: 10, height: 10, viewBox: '0 0 24 24', fill: 'currentColor', stroke: 'none',
      'aria-hidden': 'true', focusable: 'false',
      style: { flexShrink: 0 },
    }, h('path', { d: 'M13 2L4.5 12.5H11L9.5 22 19 9.5h-6.5L13 2z' }));

    /** The dim percent hint after the panel title; the full detail rides on its hover title. */

    /** Placeholder shown while the Host schedule face is not mounted (feature disabled in the profile). */
    function InertControl(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      return h('button', {
        type: 'button',
        disabled: true,
        'aria-label': t('button'),
        'aria-disabled': 'true',
        title: t('errDisabled'),
        style: { ...S.button(false), opacity: 0.45, cursor: 'default' },
      }, clockIcon());
    }

    function SendLater(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState({ left: 8, width: 300, bottom: 72, maxHeight: 480, narrow: false });
      const [choice, setChoice] = useState(() => {
        const stored = loadStored(STORE_PRESET, (v) => PRESETS.some((p) => p.id === v));
        return stored ?? '10m';
      });
      const [prompt, setPrompt] = useState(() => {
        const stored = loadStored(STORE_PROMPT, (v) => typeof v === 'string' && v.trim() !== '');
        return stored ?? t('promptDefault');
      });
      const [date, setDate] = useState(() => dateValue(new Date(Date.now() + 3600000)));
      const [time, setTime] = useState(() => timeValue(new Date(Date.now() + 3600000)));
      const [busy, setBusy] = useState(false);
      const [busyCancelId, setBusyCancelId] = useState(undefined);
      const [pending, setPending] = useState([]);
      const [snippets, setSnippets] = useState(() => loadSnippets());
      const [quota, setQuota] = useState(undefined);
      const [message, setMessage] = useState(undefined);
      const [highlightId, setHighlightId] = useState(undefined);
      const [solidAccent, setSolidAccent] = useState(false);
      const buttonRef = useRef(null);
      const panelRef = useRef(null);
      const aliveRef = useRef(true);
      const highlightTimerRef = useRef(undefined);
      const busyRef = useRef(false);
      const pendingRef = useRef([]);
      const watchdogRef = useRef(undefined);
      const propsRef = useRef(props);
      propsRef.current = props;
      if (watchdogRef.current === undefined) {
        // One watchdog per mounted control: its in-flight set belongs to this instance (Q9).
        watchdogRef.current = createWatchdog({
          listCatalog: () => propsRef.current.listCatalog(),
          runTask: (id) => propsRef.current.runTask(id),
          cancelTask: (id, expectedUpdatedAt) => propsRef.current.cancelTask(id, expectedUpdatedAt),
          persistBook: (book) => storeValue(STORE_NUDGES, book),
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          isAlive: () => aliveRef.current,
        });
      }
      pendingRef.current = pending;
      const openRef = useRef(false);
      openRef.current = open;
      const quotaRef = useRef(quota);
      quotaRef.current = quota;
      const choiceRef = useRef(choice);
      choiceRef.current = choice;
      /** True once the user types their own instant into the 指定 fields; a typed edit always wins. */
      const customTouchedRef = useRef(false);
      /** One-shot fresh-row highlight; every transition that ends a scheduling session clears it. */
      const clearFlash = () => {
        if (highlightTimerRef.current !== undefined) {
          clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = undefined;
        }
        setHighlightId(undefined);
      };
      const flashRow = (id) => {
        if (highlightTimerRef.current !== undefined) clearTimeout(highlightTimerRef.current);
        setHighlightId(id);
        highlightTimerRef.current = setTimeout(() => {
          highlightTimerRef.current = undefined;
          if (aliveRef.current) setHighlightId(undefined);
        }, 1600);
      };

      /** The default instant for the 指定 fields: the GLM 5h reset instant plus two minutes of
       *  slack when fresh quota data exists, otherwise one hour ahead. */
      const customDefaultWhen = () => {
        const q = quotaRef.current;
        if (q && q.resetAt) {
          const candidate = new Date(q.resetAt + 120000);
          const lead = candidate.getTime() - Date.now();
          if (lead >= 120000 && lead <= 7 * 3600000) return candidate;
        }
        return new Date(Date.now() + 3600000);
      };
      /** Overwrite the 指定 fields with the default; every caller has already decided overwriting is intended. */
      const applyCustomDefault = () => {
        const when = customDefaultWhen();
        setDate(dateValue(when));
        setTime(timeValue(when));
      };

      useEffect(() => () => {
        aliveRef.current = false;
        clearFlash();
      }, []);

      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const canList = typeof props.listCatalog === 'function';

      // The delivery watchdog is a module (createWatchdog, factory scope); this control only wires its ports.

      const refreshPending = async () => {
        const sid = propsRef.current.sessionId;
        if (!canList || typeof sid !== 'string' || sid === '') return;
        let entries;
        try {
          const result = await propsRef.current.listCatalog();
          entries = result && result.ok ? result.value : undefined;
        } catch (_error) {
          entries = undefined;
        }
        if (!aliveRef.current) return;
        const merged = mergePending({ registry: loadRegistry(), catalog: entries, sid, markers: TITLE_MARKERS, now: Date.now() });
        if (!merged.catalogAvailable) {
          setPending(merged.pending);
          return;
        }
        storeValue(STORE_PENDING, merged.pending.map((x) => ({ id: x.id, sessionId: sid, at: x.at, prompt: x.prompt })));
        // Delivery watchdog (silent): the Host timer loop drops failed one-shots, so a stalled
        // task can wait forever for the next unrelated schedule event. Nudge it via run-now
        // on a per-task budget; manual redelivery stays in the official automation page.
        // Scope = owned only (registry id or title prefix): the session's other active tasks
        // (e.g. hand-created in the official automation page) are never touched.
        void watchdogRef.current.scan({
          entries,
          owned: merged.owned,
          book: loadNudges(),
          onOutcome: (_id, outcome) => { if (outcome === 'retired' && aliveRef.current) refreshPending(); },
        });
        setPending(merged.pending);
      };

      // Refresh on mount, when the session changes, and after any mutation; light interval while a send is pending.
      useEffect(() => { refreshPending(); /* eslint-disable-line no-unused-vars */ }, [sessionId]);
      useEffect(() => {
        const id = window.setInterval(() => {
          if (aliveRef.current && openRef.current) {
            if (pendingRef.current.length > 0) refreshPending();
            if (typeof propsRef.current.fetchQuota === 'function') {
              propsRef.current.fetchQuota().then((q) => { if (aliveRef.current) setQuota(q && q.resetAt ? q : null); }).catch(() => {});
            }
          }
        }, 60000);
        return () => window.clearInterval(id);
      }, []);

      // Watchdog heartbeat: the stalled-delivery scan rides the same catalog poll the open
      // panel already pays; keep one light tick while the panel is closed and sends are pending.
      useEffect(() => {
        const id = window.setInterval(() => {
          if (aliveRef.current && !openRef.current && pendingRef.current.length > 0) refreshPending();
        }, 60000);
        return () => window.clearInterval(id);
      }, []);

      // Re-detect on mount and whenever the panel opens (a skin switch swaps the token sheet).
      useEffect(() => { setSolidAccent(detectSolidAccent()); }, []);
      useEffect(() => {
        if (open) setSolidAccent(detectSolidAccent());
      }, [open]);

      useEffect(() => {
        if (!open) return undefined;
        refreshPending();
        // Opening with 指定 already selected (the remembered preset) must land on the same
        // default a chip click sets — not on the stale mount-time fallback. The chip's click
        // handler never fires in this path, so the fill has to happen here (feedback: the
        // preview was only correct after toggling to another chip and back).
        if (choiceRef.current === 'custom' && !customTouchedRef.current) applyCustomDefault();
        if (typeof propsRef.current.fetchQuota === 'function') {
          propsRef.current.fetchQuota().then((q) => {
            if (!aliveRef.current) return;
            const next = q && q.resetAt ? q : null;
            setQuota(next);
            quotaRef.current = next; // set before the next render, so the fill below reads fresh data
            // Cold mount: the open fill above ran before quota data existed. Converge once it
            // arrives, unless the user has already typed their own instant in the meantime.
            if (choiceRef.current === 'custom' && !customTouchedRef.current) applyCustomDefault();
          }).catch(() => {});
        }
        const onPointer = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          if (buttonRef.current && buttonRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        // Resize must NOT close the panel: on phones the soft keyboard fires a resize when the
        // message field gains focus, which used to dismiss the card mid-edit. Reposition instead.
        const onResize = () => updateAnchor();
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        // Soft keyboards announce themselves on the visual viewport, not the window.
        const vv = window.visualViewport;
        if (vv) {
          vv.addEventListener('resize', onResize);
          vv.addEventListener('scroll', onResize);
        }
        return () => {
          document.removeEventListener('mousedown', onPointer);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', onResize);
          if (vv) {
            vv.removeEventListener('resize', onResize);
            vv.removeEventListener('scroll', onResize);
          }
        };
      }, [open]);

      const preset = PRESETS.find((item) => item.id === choice) || PRESETS[0];
      const previewAt = choice === 'custom'
        ? parseLocal(date, time)
        : new Date(Date.now() + preset.seconds * 1000);

      const updateAnchor = () => {
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : undefined;
        const narrow = window.innerWidth < 480;
        // Soft keyboards shrink the visual viewport; keep the panel above that edge when present.
        const vv = window.visualViewport;
        const keyboardEdge = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
        const visualHeight = vv ? vv.height : window.innerHeight;
        if (rect) {
          // Keep the whole panel inside the viewport: on narrow phones render a bottom sheet.
          const width = Math.min(300, window.innerWidth - 16);
          const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
          const aboveButton = window.innerHeight - rect.top + 8;
          setAnchor({
            left,
            width,
            bottom: narrow ? Math.max(8, keyboardEdge) : Math.max(aboveButton, keyboardEdge),
            maxHeight: Math.max(200, Math.min(rect.top - 16, visualHeight - 40)),
            narrow,
          });
        } else {
          setAnchor((current) => ({ ...current, narrow }));
        }
      };

      const toggle = () => {
        if (open) {
          setOpen(false);
          return;
        }
        updateAnchor();
        setMessage(undefined);
        clearFlash();
        setOpen(true);
      };

      const submit = async () => {
        if (busyRef.current) return;
        const text = prompt.trim();
        if (text === '') {
          setMessage({ kind: 'error', text: t('errEmpty') });
          return;
        }
        const current = propsRef.current;
        if (typeof current.sessionId !== 'string' || current.sessionId === '' || typeof current.schedule !== 'function') {
          setMessage({ kind: 'error', text: t('errNoSession') });
          return;
        }
        const now = Date.now();
        let when;
        let timing;
        if (choice === 'custom') {
          when = parseLocal(date, time);
          if (when === undefined || when.getTime() - now < 60000) {
            setMessage({ kind: 'error', text: t('errPast') });
            return;
          }
          const hhmmss = time.length === 5 ? `${time}:00` : time;
          timing = { kind: 'at', at: { date, time: hhmmss, time_zone: browserTimeZone() } };
        } else {
          when = new Date(now + preset.seconds * 1000);
          timing = { kind: 'after', after_seconds: preset.seconds };
        }
        busyRef.current = true;
        setBusy(true);
        setMessage(undefined);
        let result;
        try {
          result = await current.schedule({
            title: (t('titlePrefix') + text).slice(0, 120),
            prompt: text,
            timing,
            target: { kind: 'session', sessionId: current.sessionId },
          });
        } catch (error) {
          result = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
        }
        busyRef.current = false;
        if (!aliveRef.current) return;
        setBusy(false);
        if (result && result.ok) {
          storeValue(STORE_PROMPT, text);
          storeValue(STORE_PRESET, choice);
          // Custom prompts feed the snippet strip (only the latest one is kept); the default and the builtin stay out.
          const builtinText = t('snipResumeText');
          if (text !== t('promptDefault') && text !== builtinText) {
            storeValue(STORE_SNIPPETS, [text]);
            setSnippets([text]);
          }
          const createdId = result.value && typeof result.value.id === 'string' ? result.value.id : undefined;
          if (createdId) {
            const registry = loadRegistry().filter((r) => r.id !== createdId);
            registry.push({ id: createdId, sessionId: current.sessionId, at: when.toISOString(), prompt: text, ts: Date.now() });
            storeValue(STORE_PENDING, registry);
          }
          setMessage({ kind: 'done', text: t('donePrefix') + compactWhen(when) + t('doneSuffix') });
          refreshPending();
          // The panel deliberately stays open: the confirmation and the fresh pending row are
          // exactly what the user wants to see, and auto-dismissing them read as "the entry
          // vanished with the card". Closing is the user's call (✕, outside tap, Escape).
          if (createdId) flashRow(createdId);
        } else {
          const detail = (result && result.error && (result.error.message || result.error.code)) || '';
          setMessage({ kind: 'error', text: t('errFailed') + detail });
        }
      };

      const cancelPending = async (id) => {
        const current = propsRef.current;
        if (busyCancelId !== undefined || typeof current.cancelTask !== 'function') return;
        setBusyCancelId(id);
        let result;
        try {
          result = await current.cancelTask(id);
        } catch (error) {
          result = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
        }
        if (!aliveRef.current) return;
        setBusyCancelId(undefined);
        if (result && result.ok) {
          storeValue(STORE_PENDING, loadRegistry().filter((r) => r.id !== id));
          // The confirmation must not outlive the row it announced.
          setMessage(undefined);
          refreshPending();
        } else {
          const detail = (result && result.error && (result.error.message || result.error.code)) || '';
          setMessage({ kind: 'error', text: t('cancelFailed') + detail });
        }
      };


      const button = h('span', { style: S.buttonWrap },
        h('button', {
          type: 'button',
          ref: buttonRef,
          onClick: toggle,
          'aria-label': t('button'),
          title: t('button'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          style: S.button(open),
        }, clockIcon()),
        pending.length > 0 ? h('span', { 'aria-hidden': 'true', style: S.badge }, pending.length > 9 ? '9+' : String(pending.length)) : null);

      const panelBody = h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': t('panelTitle'),
        style: S.panel(anchor),
      },
        h('div', { style: S.header },
          h('div', { style: S.heading }, t('panelTitle')),
          h('button', {
            type: 'button',
            'aria-label': t('close'),
            title: t('close'),
            onClick: () => setOpen(false),
            style: S.closeBtn,
          }, crossIcon())),
        h('div', { style: S.chips }, PRESETS.map((item) => h('button', {
          key: item.id,
          type: 'button',
          'aria-pressed': item.id === choice ? 'true' : 'false',
          onClick: () => {
            setChoice(item.id);
            setMessage(undefined);
            if (item.id === 'custom') {
              // Re-selecting 指定 asks for the default again (GLM 5h reset + 2 min, or one
              // hour ahead without quota data); it also discards any typed instant.
              customTouchedRef.current = false;
              applyCustomDefault();
            }
          },
          style: S.chip(item.id === choice),
        }, t(item.label)))),
        choice === 'custom'
          ? h('div', { style: S.row },
            h('label', { style: S.field }, t('date'),
              h('input', { type: 'date', value: date, onChange: (event) => { customTouchedRef.current = true; setDate(event.target.value); }, style: S.input })),
            h('label', { style: S.field }, t('time'),
              h('input', { type: 'time', value: time, onChange: (event) => { customTouchedRef.current = true; setTime(event.target.value); }, style: S.input })))
          : null,
        h('div', { style: S.fieldRow },
          h('label', { htmlFor: 'dsh-send-later-prompt', style: S.fieldLabel }, t('promptLabel')),
          h('div', { style: S.snips },
            h('button', {
              key: 'snip-builtin',
              type: 'button',
              title: t('snipResumeText'),
              onClick: () => {
                setPrompt(t('snipResumeText'));
                setMessage(undefined);
              },
              style: S.snipChip(prompt.trim() === t('snipResumeText')),
            }, boltIcon(), t('snipResumeLabel')),
            snippets.slice(0, 1).map((x) => h('button', {
              key: x,
              type: 'button',
              title: x,
              onClick: () => {
                setPrompt(x);
                setMessage(undefined);
              },
              style: S.snipChip(prompt.trim() === x, true),
            }, boltIcon(), h('span', { style: S.snipText }, x))))),
        h('input', {
          id: 'dsh-send-later-prompt',
          type: 'text',
          value: prompt,
          placeholder: t('promptPlaceholder'),
          onChange: (event) => setPrompt(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !(event.nativeEvent && event.nativeEvent.isComposing)) {
              event.preventDefault();
              submit();
            }
          },
          style: S.input,
        }),
        pending.length > 0 ? h('div', { style: S.pendingList },
          h('div', { style: S.pendingLabel }, `${t('pendingTitle')} · ${pending.length}`),
          pending.map((item) => {
            const rel = relativeWhen(new Date(item.at), t);
            return h('div', { key: item.id, style: item.id === highlightId ? { ...S.pendingRow, ...S.pendingRowFresh } : S.pendingRow },
              h('span', { style: S.pendingWhen, 'data-when': '', title: rel.absolute }, rel.label),
              h('span', { style: S.pendingText, title: item.prompt }, item.prompt || item.id),
              h('button', {
                type: 'button',
                'aria-label': t('cancelTask'),
                title: t('cancelTask'),
                disabled: busyCancelId !== undefined,
                onClick: () => cancelPending(item.id),
                style: S.pendingCancel,
              }, busyCancelId === item.id ? t('cancelling').slice(0, 1) : crossIcon()));
          }))
          : null,
        message ? h('div', { role: 'status', style: message.kind === 'error' ? S.error : S.done }, message.text) : null,
        h('div', { style: S.footer },
          previewAt ? h('div', { style: S.summary }, t('summaryPrefix') + compactWhen(previewAt) + t('summarySuffix')) : null,
          h('button', { type: 'button', onClick: submit, disabled: busy, style: { ...S.primary(solidAccent), opacity: busy ? 0.6 : 1 } }, busy ? t('busy') : t('submit'))));

      return h(React.Fragment, null,
        button,
        open ? ReactDOM.createPortal(panelBody, document.body) : null);
    }

    return {
      // Pure helpers and the watchdog module, exposed for the offline tests. The host reads only inject/apply.
      internals: { mergePending, isStalled, pastGrace, dueNudges, applyAttempt, forgetNudge, markArchived, isAdmittedRun, createWatchdog, titleMarkers: TITLE_MARKERS },
      inject: ['locale', 'slots', 'remote'],
      apply(ctx) {
        ensureFlashStyles();
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'send-later: en dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'send-later: zh dictionary');
        ctx.effect(() => {
          // Placeholder first: keeps the entry point visible (greyed out) even when the
          // Automation tasks feature is disabled, where the schedule face never appears.
          const disposePlaceholder = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
            name: 'conversation.input.right',
            id: 'send-later',
            locale: NS,
            inject: () => ({}),
          }, InertControl));
          let disposeFull;
          const undoInject = ctx.inject(['remote.schedule'], (scope) => {
            if (disposeFull) return;
            // Access the face through the inject scope: touching ctx.remote.schedule here
            // would throw "cannot get property ... without inject" (strict Local getters).
            const api = (scope && scope.remote && scope.remote.schedule) || (scope && scope['remote.schedule']);
            disposePlaceholder();
            disposeFull = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
              name: 'conversation.input.right',
              id: 'send-later',
              locale: NS,
              inject: (sessionId) => ({
                sessionId,
                schedule: (request) => api.create(request),
                listCatalog: () => api.catalog(),
                cancelTask: (id, expectedUpdatedAt) => api.edit(expectedUpdatedAt === undefined
                  ? { id, action: 'delete' }
                  : { id, action: 'delete', expectedUpdatedAt }),
                runTask: (id) => api.run({ id }),
                fetchQuota: () => fetchGlm5hQuota(),
              }),
            }, SendLater));
          });
          return () => {
            if (typeof undoInject === 'function') undoInject();
            disposePlaceholder();
            if (disposeFull) disposeFull();
          };
        }, 'send-later: composer control');
      },
    };
  },
});
