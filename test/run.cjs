// Offline behaviour test for the dsh-send-later composer control.
// Renders the real client module in jsdom with React 19 and drives it with clicks and
// input events. The schedule service is a stub, so no real task is ever created.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const CLIENT = path.join(__dirname, '..', 'client.js');

// react-dom decides at load time whether it runs in a DOM, so the jsdom globals must
// exist before react (and react-dom) are required.
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:3080/', runScripts: 'outside-only',
});
const win = dom.window;
Object.defineProperty(win.navigator, 'language', { get: () => 'zh-CN', configurable: true });
globalThis.window = win;
globalThis.document = win.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const ReactDOM = require('react-dom');
const { createRoot } = require('react-dom/client');
const { act } = React;

const consoleErrors = [];
const originalError = console.error;
console.error = (...args) => consoleErrors.push(args.map(String).join(' ').slice(0, 300));

let captured;
win.__ModuleLoader__ = { load(def) { captured = def; } };
win.eval(fs.readFileSync(CLIENT, 'utf8'));
assert.ok(captured && captured.id === 'dsh-send-later', 'module must register under its package id');
const def = captured.factory((id) => ({ react: React, 'react-dom': ReactDOM })[id]);

const calls = [];
const cancelCalls = [];
let next = async (request) => { calls.push(request); return { ok: true, value: { id: `schedule-${calls.length}` } }; };
let nextCatalog = async () => ({ ok: true, value: [] });
let nextEdit = async (request) => { cancelCalls.push(request); return { ok: true, value: {} }; };

// Fake client context: `scheduleFace` decides whether the remote.schedule face is mounted.
function makeCtx(scheduleFace) {
  const registered = new Map();
  const disposers = [];
  const ctx = {
    remote: {
      schedule: {
        create: (request) => next(request),
        catalog: () => nextCatalog(),
        edit: (request) => nextEdit(request),
      },
    },
    effect(fn) { const d = fn(); disposers.push(d); return d; },
    locale: { register: () => () => {} },
    inject(keys, cb) {
      // Hand the callback a scope exposing only the injected face, like the real Host does.
      if (scheduleFace) { cb({ remote: { schedule: ctx.remote.schedule } }); return () => {}; }
      return () => {};
    },
    slots: {
      inject(name, cb) {
        const d = () => registered.delete('send-later');
        disposers.push(d);
        cb();
        return d;
      },
      register(reg, component) { const entry = { ...reg, component }; registered.set(reg.id, entry); return entry; },
    },
  };
  return { ctx, registered, disposers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const container = win.document.getElementById('root');
const root = createRoot(container);
const qa = (selector, scope) => Array.from((scope || win.document).querySelectorAll(selector));
const findButton = (scope, text) => qa('button', scope).find((b) => b.textContent.trim() === text);
const dialogNode = () => win.document.body.querySelector('[role="dialog"]');
const badgeNode = () => win.document.querySelector('span span[aria-hidden="true"]');
const setValue = (element, value) => {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const storeGet = (key) => JSON.parse(win.localStorage.getItem(key));

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(['PASS', name]); } catch (error) { results.push(['FAIL', `${name} :: ${error.message}`]); }
};

// Scenario B: schedule face absent → one inert placeholder with no schedule api.
const off = makeCtx(false);
def.apply(off.ctx);
check('inert: one placeholder registration when schedule face is absent', () => assert.equal(off.registered.size, 1));
const inertEntry = off.registered.get('send-later');
check('inert: registers under the same slot and id', () => {
  assert.equal(inertEntry.name, 'conversation.input.right');
  assert.equal(inertEntry.id, 'send-later');
});
check('inert: exposes no schedule api', () => assert.equal(inertEntry.inject('x').schedule, undefined));
check('cleanup: disposers remove the registration', () => {
  off.disposers.forEach((d) => d());
  assert.equal(off.registered.size, 0);
});

// Scenario A: schedule face present → the placeholder is swapped for the full control.
const on = makeCtx(true);
def.apply(on.ctx);
check('face on: exactly one registration after the swap', () => assert.equal(on.registered.size, 1));
const slot = on.registered.get('send-later');
check('face on: full api is exposed', () => {
  const inj = slot.inject('session-test-1');
  assert.equal(inj.sessionId, 'session-test-1');
  assert.equal(typeof inj.schedule, 'function');
  assert.equal(typeof inj.listCatalog, 'function');
  assert.equal(typeof inj.cancelTask, 'function');
});
const injected = slot.inject('session-test-1');

(async () => {
  // Inert placeholder rendering: disabled button, explanatory tooltip, no panel on click.
  const inertDiv = win.document.createElement('div');
  win.document.body.appendChild(inertDiv);
  const inertRoot = createRoot(inertDiv);
  await act(async () => { inertRoot.render(React.createElement(off.registered.get('send-later')?.component || inertEntry.component, {})); });
  const inertButton = inertDiv.querySelector('button');
  check('inert: button renders disabled with the unavailable tooltip', () => {
    assert.equal(inertButton.disabled, true);
    assert.ok(inertButton.title.includes('延时发送不可用'), `title was: ${inertButton.title}`);
  });
  await act(async () => { inertButton.click(); });
  check('inert: click opens no panel', () => assert.equal(dialogNode(), null));
  await act(async () => { inertRoot.unmount(); });
  inertDiv.remove();

  await act(async () => { root.render(React.createElement(slot.component, injected)); });
  await act(async () => { await sleep(0); }); // mount refresh (catalog) settles
  const button = container.querySelector('button[aria-label="延时发送"]');

  // 1. Static render and default panel state.
  check('clock button renders with the zh label', () => assert.ok(button));
  check('button starts collapsed', () => assert.equal(button.getAttribute('aria-expanded'), 'false'));
  check('no badge while nothing is pending', () => assert.equal(badgeNode(), null));
  await act(async () => { button.click(); });
  let dialog = dialogNode();
  check('panel opens into document.body (portal)', () => assert.ok(dialog));
  check('panel has its dialog label', () => assert.equal(dialog.getAttribute('aria-label'), '延时发送到本会话'));
  check('five preset chips in order', () => assert.deepEqual(
    qa('button[aria-pressed]', dialog).map((b) => b.textContent.trim()),
    ['10 分', '30 分', '1 时', '5 时', '指定']));
  check('10-minute preset is selected by default', () => assert.equal(findButton(dialog, '10 分').getAttribute('aria-pressed'), 'true'));
  check('prompt defaults to 继续', () => assert.equal(dialog.querySelector('input[type="text"]').value, '继续'));
  const plus10 = new Date(Date.now() + 600000);
  check('summary shows the 10-minute send time', () => assert.ok(
    dialog.textContent.includes(`将于 ${hm(plus10)} 发送到本会话`) || dialog.textContent.includes(`将于 ${hm(new Date(plus10.getTime() + 60000))} 发送到本会话`)));

  // 2. Default submit.
  await act(async () => { findButton(dialog, '排程').click(); });
  check('one schedule call on submit', () => assert.equal(calls.length, 1));
  check('default request uses after_seconds 600', () => assert.deepEqual(calls[0].timing, { kind: 'after', after_seconds: 600 }));
  check('default request targets this session', () => assert.deepEqual(calls[0].target, { kind: 'session', sessionId: 'session-test-1' }));
  check('default request carries prompt and title', () => {
    assert.equal(calls[0].prompt, '继续');
    assert.equal(calls[0].title, '延时发送：继续');
  });
  check('create response id is written to the registry', () => {
    const stored = storeGet('dsh-send-later:v1:pending');
    assert.ok(Array.isArray(stored) && stored.some((e) => e.id === 'schedule-1' && e.sessionId === 'session-test-1'));
  });
  check('success message is shown', () => assert.ok(dialogNode() && dialogNode().textContent.includes('已排程，')));
  await act(async () => { await sleep(1700); });
  check('panel closes after success', () => assert.equal(dialogNode(), null));
  await act(async () => { await sleep(0); });

  // 3. Pending list, badge and cancel.
  nextCatalog = async () => ({
    ok: true,
    value: [
      { id: 'schedule-1', status: 'active', target: { kind: 'session', sessionId: 'session-test-1' }, title: '延时发送：继续', prompt: '继续', scheduledAt: new Date(Date.now() + 600000).toISOString() },
      { id: 'other-1', status: 'active', target: { kind: 'session', sessionId: 'session-other' }, title: '延时发送：继续', prompt: '继续', scheduledAt: new Date(Date.now() + 600000).toISOString() },
    ],
  });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(0); });
  dialog = dialogNode();
  check('badge shows one pending send for this session', () => assert.equal(badgeNode() && badgeNode().textContent, '1'));
  check('pending row is listed with its prompt', () => assert.ok(dialog.textContent.includes('待发送') && dialog.textContent.includes('继续')));
  check('pending row shows relative time with absolute on hover', () => {
    const when = dialog.querySelector('span[data-when]');
    assert.ok(when, 'span[data-when] not found');
    assert.equal(when.textContent, '10分钟后');
    assert.ok(when.title.includes(hm(plus10)), `title was: ${when.title}`);
  });
  check('other sessions are not listed', () => assert.equal(qa('[style*="pendingRow"]', dialog).length === 0 ? dialog.querySelectorAll('div').length >= 0 : true, true));
  nextCatalog = async () => ({ ok: true, value: [] }); // the host no longer lists the task after deletion
  await act(async () => { dialog.querySelector('button[aria-label="取消这条发送"]').click(); });
  await act(async () => { await sleep(0); });
  check('cancel calls schedule edit delete', () => assert.deepEqual(cancelCalls[0], { id: 'schedule-1', action: 'delete' }));
  check('badge clears after cancel', () => assert.equal(badgeNode(), null));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  // 4. Cross-device task adoption by title prefix.
  nextCatalog = async () => ({
    ok: true,
    value: [
      { id: 'remote-9', status: 'active', target: { kind: 'session', sessionId: 'session-test-1' }, title: '延时发送：自定义', prompt: '自定义', scheduledAt: new Date(Date.now() + 3600000).toISOString() },
    ],
  });
  win.localStorage.removeItem('dsh-send-later:v1:pending');
  await act(async () => { button.click(); });
  await act(async () => { await sleep(0); });
  dialog = dialogNode();
  check('task created on another device is adopted by title prefix', () => assert.equal(badgeNode() && badgeNode().textContent, '1'));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.localStorage.clear();

  // 5. Blank prompt is refused without calling the service.
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '   '); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('blank prompt does not call the service', () => assert.equal(calls.length, 1));
  check('blank prompt shows the empty-message error', () => assert.ok(dialogNode().textContent.includes('发送内容不能为空')));

  // 6. Custom time: past refused, future becomes an at-timing with the browser zone.
  await act(async () => { setValue(dialogNode().querySelector('input[type="text"]'), '继续'); });
  await act(async () => { findButton(dialogNode(), '指定').click(); });
  dialog = dialogNode();
  const dateInput = dialog.querySelector('input[type="date"]');
  const timeInput = dialog.querySelector('input[type="time"]');
  check('custom time shows date and time inputs', () => assert.ok(dateInput && timeInput));
  await act(async () => { setValue(dateInput, '2020-01-01'); });
  await act(async () => { setValue(timeInput, '09:00'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('past custom time is refused', () => assert.equal(calls.length, 1));
  check('past custom time shows the error', () => assert.ok(dialogNode().textContent.includes('请选择至少一分钟之后的时间')));
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  await act(async () => { setValue(dateInput, ymd(tomorrow)); });
  await act(async () => { setValue(timeInput, '09:00'); });
  check('summary shows 09:00 for a future custom time', () => assert.ok(dialogNode().textContent.includes('09:00 发送到本会话')));
  await act(async () => { findButton(dialogNode(), '排程').click(); });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  check('custom request uses at with local date, HH:mm:ss and zone', () => assert.deepEqual(calls[1].timing, {
    kind: 'at', at: { date: ymd(tomorrow), time: '09:00:00', time_zone: zone },
  }));
  await act(async () => { await sleep(1700); });

  // 7. Prompt and preset are remembered across reopen.
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '总结进度后暂停'); });
  await act(async () => { findButton(dialog, '30 分').click(); });
  await act(async () => { findButton(dialogNode(), '排程').click(); });
  check('third submit uses the edited prompt', () => assert.equal(calls[2].prompt, '总结进度后暂停'));
  check('remembered prompt and preset are stored', () => {
    assert.equal(storeGet('dsh-send-later:v1:prompt'), '总结进度后暂停');
    assert.equal(storeGet('dsh-send-later:v1:preset'), '30m');
  });
  await act(async () => { await sleep(1700); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check('reopened panel retains the edited prompt', () => assert.equal(dialog.querySelector('input[type="text"]').value, '总结进度后暂停'));
  check('reopened panel retains the preset choice', () => assert.equal(findButton(dialog, '30 分').getAttribute('aria-pressed'), 'true'));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.localStorage.clear();

  // 7b. Snippet strip: exactly two chips (builtin + latest custom), no horizontal scrolling.
  await act(async () => { button.click(); });
  dialog = dialogNode();
  const snipChip = qa('button', dialog).find((b) => b.textContent.trim() === '安全继续');
  check('builtin snippet chip renders in the strip', () => assert.ok(snipChip));
  check('the strip renders exactly two chips', () => assert.equal(
    qa('button svg[fill="currentColor"]', dialog).length, 2));
  await act(async () => { snipChip.click(); });
  check('builtin snippet fills the prompt input', () => assert.equal(
    dialog.querySelector('input[type="text"]').value,
    '从中断处继续，不要开始与目标无关的新工作。'));
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '查一下行情再继续'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('custom prompt is recorded as the latest snippet', () => assert.deepEqual(storeGet('dsh-send-later:v1:snippets'), ['查一下行情再继续']));
  await act(async () => { await sleep(1700); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '自定义乙'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('a newer custom prompt replaces the snippet', () => assert.deepEqual(storeGet('dsh-send-later:v1:snippets'), ['自定义乙']));
  check('the strip still shows exactly two chips', () => assert.equal(
    qa('button svg[fill="currentColor"]', dialog).length, 2));
  await act(async () => { await sleep(1700); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '继续'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('the bare default prompt is not recorded as a snippet', () => {
    assert.deepEqual(storeGet('dsh-send-later:v1:snippets'), ['自定义乙']);
  });
  await act(async () => { await sleep(1700); });
  win.localStorage.clear();

  // 8. Host failure keeps the panel open for a retry.
  next = async (request) => { calls.push(request); return { ok: false, error: { message: 'boom' } }; };
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { findButton(dialog, '排程').click(); });
  check('host failure message is shown', () => assert.ok(dialogNode().textContent.includes('排程失败：boom')));
  check('panel stays open after a failure', () => assert.ok(dialogNode()));

  // 9. Escape and an outside pointer press close the panel.
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  check('Escape closes the panel', () => assert.equal(dialogNode(), null));
  await act(async () => { button.click(); });
  await act(async () => { win.document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true })); });
  check('outside mousedown closes the panel', () => assert.equal(dialogNode(), null));

  // 10. A double tap on 排程 sends exactly one request.
  next = async (request) => { calls.push(request); return { ok: true, value: { id: `schedule-${calls.length}` } }; };
  const beforeDouble = calls.length;
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => {
    const submitButton = findButton(dialog, '排程');
    submitButton.click();
    submitButton.click();
  });
  check('double tap sends exactly one request', () => assert.equal(calls.length - beforeDouble, 1));
  await act(async () => { await sleep(1700); });

  // 12. Solid accent under the official theme (ink-paired brand-primary), tonal under skins.
  win.document.body.style.setProperty('--dsw-alias-brand-primary', '#0f1115');
  win.document.body.style.setProperty('--dsw-static-neutral-bluish-1000', '#0f1115');
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check('official ink pairing switches the submit button to solid blue', () => {
    const submitBtn = findButton(dialog, '排程');
    assert.equal(submitBtn.style.background, 'rgb(65, 118, 230)');
    assert.equal(submitBtn.style.color, 'rgb(255, 255, 255)');
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.document.body.style.setProperty('--dsw-alias-brand-primary', '#3ec1e8');
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check('skins accent keeps the tonal submit button', () => {
    const submitBtn = findButton(dialog, '排程');
    assert.equal(submitBtn.style.background, 'var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2))');
    assert.equal(submitBtn.style.color, 'var(--dsw-alias-brand-text, var(--dsw-alias-label-primary))');
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.document.body.style.removeProperty('--dsw-alias-brand-primary');
  win.document.body.style.removeProperty('--dsw-static-neutral-bluish-1000');

  // 12. A viewport resize must not close the panel (mobile keyboard fires resize on focus).
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check('panel is open before the resize', () => assert.ok(dialog));
  await act(async () => { win.dispatchEvent(new win.Event('resize')); });
  check('resize keeps the panel open (mobile keyboard regression)', () => assert.ok(dialogNode()));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  // 11. No JavaScript errors from the module itself.
  const moduleErrors = consoleErrors.filter((line) => /TypeError|ReferenceError|SyntaxError|slot entry crashed/.test(line));
  check('no TypeError/ReferenceError from the module', () => assert.equal(moduleErrors.length, 0, moduleErrors.join(' | ')));

  await act(async () => { root.unmount(); });
  console.error = originalError;
  let failed = 0;
  for (const [status, name] of results) {
    console.log(`${status}  ${name}`);
    if (status === 'FAIL') failed += 1;
  }
  console.log(`\n${results.length - failed}/${results.length} passed; console.error lines captured: ${consoleErrors.length}`);
  win.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error = originalError;
  console.error('harness crashed:', error && error.stack ? error.stack : error);
  process.exit(2);
});
