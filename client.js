/*
 * Client half of @iasiv5/dsh-send-later.
 * Adds a clock button before the composer's submit action. The popover asks for a delay
 * or a local time plus a message, then asks the Host Schedule service to deliver that
 * message to the current session as a one-shot task. Pending sends for this session are
 * listed in the panel and can be cancelled; the button shows a count badge. No timer or
 * delivery logic lives here — the Host Schedule service owns persistence and delivery.
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
    };

    const PRESETS = [
      { id: '10m', seconds: 600, label: 'preset10m' },
      { id: '30m', seconds: 1800, label: 'preset30m' },
      { id: '1h', seconds: 3600, label: 'preset1h' },
      { id: '5h', seconds: 18000, label: 'preset5h' },
      { id: 'custom', seconds: 0, label: 'presetCustom' },
    ];

    const fallbackDict = /^zh/i.test(navigator.language || '') ? ZH : EN;
    const fallbackT = (key) => (fallbackDict[key] !== undefined ? fallbackDict[key] : (EN[key] !== undefined ? EN[key] : key));

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
      header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
      heading: { fontWeight: 600, fontSize: 13 },
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
      const [message, setMessage] = useState(undefined);
      const [solidAccent, setSolidAccent] = useState(false);
      const buttonRef = useRef(null);
      const panelRef = useRef(null);
      const aliveRef = useRef(true);
      const timerRef = useRef(undefined);
      const busyRef = useRef(false);
      const pendingRef = useRef([]);
      const propsRef = useRef(props);
      propsRef.current = props;
      pendingRef.current = pending;

      useEffect(() => () => {
        aliveRef.current = false;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      }, []);

      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const canList = typeof props.listCatalog === 'function';

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
        const prefix = t('titlePrefix');
        const isOurs = (entry) => entry && entry.status === 'active'
          && entry.target && entry.target.kind === 'session' && entry.target.sessionId === sid;
        if (!Array.isArray(entries)) {
          // Catalog unavailable: fall back to the local registry so the badge stays honest.
          setPending(loadRegistry().filter((r) => r.sessionId === sid)
            .map((r) => ({ id: r.id, at: r.at, prompt: typeof r.prompt === 'string' ? r.prompt : '' })));
          return;
        }
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const live = [];
        const seen = new Set();
        for (const r of loadRegistry()) {
          const entry = byId.get(r.id);
          if (entry && isOurs(entry) && !seen.has(r.id)) {
            live.push({ id: r.id, at: entry.scheduledAt || r.at, prompt: typeof entry.prompt === 'string' ? entry.prompt : r.prompt || '' });
            seen.add(r.id);
          }
        }
        // Adopt tasks created elsewhere (another browser/device) that carry our title marker.
        for (const entry of entries) {
          if (isOurs(entry) && !seen.has(entry.id)
            && typeof entry.title === 'string' && entry.title.startsWith(prefix)) {
            live.push({ id: entry.id, at: entry.scheduledAt, prompt: typeof entry.prompt === 'string' ? entry.prompt : '' });
            seen.add(entry.id);
          }
        }
        // Keep just-created entries the catalog does not know about yet (catalog can lag behind a create).
        const now = Date.now();
        for (const r of loadRegistry()) {
          if (!seen.has(r.id) && r.sessionId === sid
            && typeof r.ts === 'number' && now - r.ts < 300000) {
            live.push({ id: r.id, at: r.at, prompt: typeof r.prompt === 'string' ? r.prompt : '' });
            seen.add(r.id);
          }
        }
        live.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        storeValue(STORE_PENDING, live.map((x) => ({ id: x.id, sessionId: sid, at: x.at, prompt: x.prompt })));
        setPending(live);
      };

      // Refresh on mount, when the session changes, and after any mutation; light interval while a send is pending.
      useEffect(() => { refreshPending(); /* eslint-disable-line no-unused-vars */ }, [sessionId]);
      useEffect(() => {
        const id = window.setInterval(() => {
          if (aliveRef.current && pendingRef.current.length > 0) refreshPending();
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
        return () => {
          document.removeEventListener('mousedown', onPointer);
          document.removeEventListener('keydown', onKey);
          window.removeEventListener('resize', onResize);
        };
      }, [open]);

      const preset = PRESETS.find((item) => item.id === choice) || PRESETS[0];
      const previewAt = choice === 'custom'
        ? parseLocal(date, time)
        : new Date(Date.now() + preset.seconds * 1000);

      const updateAnchor = () => {
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : undefined;
        const narrow = window.innerWidth < 480;
        if (rect) {
          // Keep the whole panel inside the viewport: on narrow phones render a bottom sheet.
          const width = Math.min(300, window.innerWidth - 16);
          const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
          setAnchor({
            left,
            width,
            bottom: window.innerHeight - rect.top + 8,
            maxHeight: Math.max(200, rect.top - 16),
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
          const createdId = result.value && typeof result.value.id === 'string' ? result.value.id : undefined;
          if (createdId) {
            const registry = loadRegistry().filter((r) => r.id !== createdId);
            registry.push({ id: createdId, sessionId: current.sessionId, at: when.toISOString(), prompt: text, ts: Date.now() });
            storeValue(STORE_PENDING, registry);
          }
          setMessage({ kind: 'done', text: t('donePrefix') + compactWhen(when) + t('doneSuffix') });
          refreshPending();
          timerRef.current = setTimeout(() => {
            if (aliveRef.current) setOpen(false);
          }, 1600);
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
          },
          style: S.chip(item.id === choice),
        }, t(item.label)))),
        choice === 'custom'
          ? h('div', { style: S.row },
            h('label', { style: S.field }, t('date'),
              h('input', { type: 'date', value: date, onChange: (event) => setDate(event.target.value), style: S.input })),
            h('label', { style: S.field }, t('time'),
              h('input', { type: 'time', value: time, onChange: (event) => setTime(event.target.value), style: S.input })))
          : null,
        h('label', { style: S.field }, t('promptLabel'),
          h('input', {
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
          })),
        pending.length > 0 ? h('div', { style: S.pendingList },
          h('div', { style: S.pendingLabel }, `${t('pendingTitle')} · ${pending.length}`),
          pending.map((item) => {
            const rel = relativeWhen(new Date(item.at), t);
            return h('div', { key: item.id, style: S.pendingRow },
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
      inject: ['locale', 'slots', 'remote'],
      apply(ctx) {
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
                cancelTask: (id) => api.edit({ id, action: 'delete' }),
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
