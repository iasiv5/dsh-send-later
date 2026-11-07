/*
 * Client half of @local/dsh-send-later.
 * Adds a clock button before the composer's submit action. The popover asks for a delay
 * or a local time plus a message, then asks the Host Schedule service to deliver that
 * message to the current session as a one-shot task. No timer or storage lives here.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-send-later',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useEffect, useRef, useState } = React;

    const NS = 'send-later';

    const EN = {
      button: 'Send later',
      panelTitle: 'Send later to this session',
      preset10m: 'In 10 min',
      preset30m: 'In 30 min',
      preset1h: 'In 1 hour',
      preset5h: 'In 5 hours',
      presetCustom: 'Custom',
      date: 'Date',
      time: 'Time',
      promptLabel: 'Message',
      promptDefault: 'Continue',
      promptPlaceholder: 'Message to send',
      summaryPrefix: 'Sends at ',
      summarySuffix: ' to this session',
      cancel: 'Cancel',
      submit: 'Schedule',
      busy: 'Scheduling…',
      donePrefix: 'Scheduled for ',
      doneSuffix: '',
      titlePrefix: 'Send later: ',
      errEmpty: 'The message cannot be empty.',
      errPast: 'Choose a time at least one minute ahead.',
      errNoSession: 'No session is available.',
      errFailed: 'Scheduling failed: ',
    };

    const ZH = {
      button: '延时发送',
      panelTitle: '延时发送到本会话',
      preset10m: '10 分钟后',
      preset30m: '30 分钟后',
      preset1h: '1 小时后',
      preset5h: '5 小时后',
      presetCustom: '指定时间',
      date: '日期',
      time: '时间',
      promptLabel: '发送内容',
      promptDefault: '继续',
      promptPlaceholder: '要发送的内容',
      summaryPrefix: '将于 ',
      summarySuffix: ' 发送到本会话',
      cancel: '取消',
      submit: '排程',
      busy: '排程中…',
      donePrefix: '已排程，',
      doneSuffix: ' 发送',
      titlePrefix: '延时发送：',
      errEmpty: '发送内容不能为空。',
      errPast: '请选择至少一分钟之后的时间。',
      errNoSession: '当前没有可用的会话。',
      errFailed: '排程失败：',
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

    function parseLocal(date, time) {
      const [year, month, day] = String(date).split('-').map(Number);
      const [hour, minute] = String(time).split(':').map(Number);
      if ([year, month, day, hour, minute].some((value) => !Number.isInteger(value))) return undefined;
      const when = new Date(year, month - 1, day, hour, minute, 0, 0);
      return Number.isNaN(when.getTime()) ? undefined : when;
    }

    function browserTimeZone() {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch (_error) {
        return 'UTC';
      }
    }

    const S = {
      button: (open) => ({
        width: 28, height: 28, padding: 0, borderRadius: 8, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: open ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
        color: open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      panel: (anchor) => ({
        position: 'fixed', left: anchor.left, bottom: anchor.bottom, zIndex: 1000,
        width: anchor.width, maxWidth: 'calc(100vw - 16px)', maxHeight: anchor.maxHeight,
        overflowY: 'auto', boxSizing: 'border-box', padding: 12,
        display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
        fontSize: 13, lineHeight: 1.4,
      }),
      heading: { fontWeight: 600 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: (on) => ({
        padding: '4px 10px', borderRadius: 999, cursor: 'pointer', fontSize: 12,
        border: `1px solid ${on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
        background: on ? 'var(--dsw-alias-interactive-bg-active)' : 'transparent',
        color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
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
      summary: { color: 'var(--dsw-alias-label-secondary)' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
      done: { color: 'var(--dsw-alias-state-success-primary)' },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
      secondary: {
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      primary: (busy) => ({
        padding: '6px 12px', borderRadius: 8, cursor: busy ? 'default' : 'pointer', fontSize: 13,
        border: 'none', opacity: busy ? 0.6 : 1,
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary-invert)',
      }),
    };

    const clockIcon = () => h('svg', {
      width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': 'true', focusable: 'false',
    }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3 2' }));

    function SendLater(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT;
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState({ left: 8, width: 300, bottom: 72, maxHeight: 480 });
      const [choice, setChoice] = useState('10m');
      const [prompt, setPrompt] = useState(() => t('promptDefault'));
      const [date, setDate] = useState(() => dateValue(new Date(Date.now() + 3600000)));
      const [time, setTime] = useState(() => timeValue(new Date(Date.now() + 3600000)));
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(undefined);
      const buttonRef = useRef(null);
      const panelRef = useRef(null);
      const aliveRef = useRef(true);
      const timerRef = useRef(undefined);
      const busyRef = useRef(false);

      useEffect(() => () => {
        aliveRef.current = false;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          if (panelRef.current && panelRef.current.contains(event.target)) return;
          if (buttonRef.current && buttonRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onResize = () => setOpen(false);
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

      const toggle = () => {
        if (open) {
          setOpen(false);
          return;
        }
        const rect = buttonRef.current ? buttonRef.current.getBoundingClientRect() : undefined;
        if (rect) {
          // Keep the whole panel inside the viewport: on narrow phones the button sits well left of the edge.
          const width = Math.min(300, window.innerWidth - 16);
          const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
          setAnchor({
            left,
            width,
            bottom: window.innerHeight - rect.top + 8,
            maxHeight: Math.max(200, rect.top - 16),
          });
        }
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
        if (typeof props.sessionId !== 'string' || props.sessionId === '' || typeof props.schedule !== 'function') {
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
          result = await props.schedule({
            title: (t('titlePrefix') + text).slice(0, 120),
            prompt: text,
            timing,
            target: { kind: 'session', sessionId: props.sessionId },
          });
        } catch (error) {
          result = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
        }
        busyRef.current = false;
        if (!aliveRef.current) return;
        setBusy(false);
        if (result && result.ok) {
          setMessage({ kind: 'done', text: t('donePrefix') + timeValue(when) + t('doneSuffix') });
          timerRef.current = setTimeout(() => {
            if (aliveRef.current) setOpen(false);
          }, 1600);
        } else {
          const detail = (result && result.error && (result.error.message || result.error.code)) || '';
          setMessage({ kind: 'error', text: t('errFailed') + detail });
        }
      };

      const button = h('button', {
        type: 'button',
        ref: buttonRef,
        onClick: toggle,
        'aria-label': t('button'),
        title: t('button'),
        'aria-haspopup': 'dialog',
        'aria-expanded': open ? 'true' : 'false',
        style: S.button(open),
      }, clockIcon());

      const panelBody = h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-label': t('panelTitle'),
        style: S.panel(anchor),
      },
        h('div', { style: S.heading }, t('panelTitle')),
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
        previewAt ? h('div', { style: S.summary }, t('summaryPrefix') + timeValue(previewAt) + t('summarySuffix')) : null,
        message ? h('div', { role: 'status', style: message.kind === 'error' ? S.error : S.done }, message.text) : null,
        h('div', { style: S.footer },
          h('button', { type: 'button', onClick: () => setOpen(false), style: S.secondary }, t('cancel')),
          h('button', { type: 'button', onClick: submit, disabled: busy, style: S.primary(busy) }, busy ? t('busy') : t('submit'))));

      return h(React.Fragment, null,
        button,
        open ? ReactDOM.createPortal(panelBody, document.body) : null);
    }

    return {
      inject: ['locale', 'slots', 'remote', 'remote.schedule'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'send-later: en dictionary');
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'send-later: zh dictionary');
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'send-later',
          locale: NS,
          inject: (sessionId) => ({
            sessionId,
            schedule: (request) => ctx.remote.schedule.create(request),
          }),
        }, SendLater));
      },
    };
  },
});
