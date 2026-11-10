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
const runCalls = [];
let nextRun = async () => ({ ok: true, value: {} });
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
        run: (request) => { runCalls.push(request); return nextRun(); },
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
  assert.equal(typeof inj.runTask, 'function');
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
  await act(async () => { await sleep(50); }); // mount refresh (catalog) settles
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
  check('panel stays open after success', () => assert.ok(dialogNode()));
  await act(async () => { await sleep(50); }); // refreshPending settles and paints the fresh row
  check('fresh row is highlighted once', () => assert.ok(dialogNode().querySelector('[style*="send-later-flash"]')));
  await act(async () => { await sleep(1700); });
  check('panel still open 1.7s later (no auto-dismiss)', () => assert.ok(dialogNode()));
  check('fresh-row highlight has faded', () => assert.equal(dialogNode().querySelector('[style*="send-later-flash"]'), null));
  check('confirmation survives the highlight fade', () => assert.ok(dialogNode().textContent.includes('已排程，')));
  // Lifecycle (c): cancelling the row must clear the confirmation that announced it.
  await act(async () => { dialogNode().querySelector('button[aria-label="取消这条发送"]').click(); });
  await act(async () => { await sleep(50); });
  check('cancel success clears the confirmation', () => assert.ok(dialogNode() && !dialogNode().textContent.includes('已排程，')));
  check('badge clears after the row is cancelled', () => assert.equal(badgeNode(), null));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  // 3. Pending list, badge and cancel.
  // rowAt is sampled once and reused by the assertion below: deriving the expected time from
  // plus10 (captured seconds earlier in scenario 1) flakes whenever a minute boundary falls
  // between the two samples.
  const rowAt = new Date(Date.now() + 600000);
  nextCatalog = async () => ({
    ok: true,
    value: [
      { id: 'schedule-1', status: 'active', target: { kind: 'session', sessionId: 'session-test-1' }, title: '延时发送：继续', prompt: '继续', scheduledAt: rowAt.toISOString() },
      { id: 'other-1', status: 'active', target: { kind: 'session', sessionId: 'session-other' }, title: '延时发送：别的会话的发送', prompt: '别的会话的发送', scheduledAt: rowAt.toISOString() },
    ],
  });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(50); });
  dialog = dialogNode();
  check('badge shows one pending send for this session', () => assert.equal(badgeNode() && badgeNode().textContent, '1'));
  check('pending row is listed with its prompt', () => assert.ok(dialog.textContent.includes('待发送') && dialog.textContent.includes('继续')));
  check('pending row shows relative time with absolute on hover', () => {
    const when = dialog.querySelector('span[data-when]');
    assert.ok(when, 'span[data-when] not found');
    assert.equal(when.textContent, '10分钟后');
    assert.ok(when.title.includes(hm(rowAt)), `title was: ${when.title}`);
  });
  check("other sessions are not listed: only this session's send is a row", () => {
    assert.equal(qa('span[title="继续"]', dialog).length, 1, 'expected exactly one row for this session');
    assert.ok(!dialog.textContent.includes('别的会话的发送'), "the other session's send must not be listed");
  });
  nextCatalog = async () => ({ ok: true, value: [] }); // the host no longer lists the task after deletion
  await act(async () => { dialog.querySelector('button[aria-label="取消这条发送"]').click(); });
  await act(async () => { await sleep(50); });
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
  await act(async () => { await sleep(50); });
  dialog = dialogNode();
  check('task created on another device is adopted by title prefix', () => assert.equal(badgeNode() && badgeNode().textContent, '1'));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.localStorage.clear();

  // 4b. Cross-language adoption: a send created with the English marker is adopted here too (Q2).
  nextCatalog = async () => ({
    ok: true,
    value: [
      { id: 'remote-en', status: 'active', target: { kind: 'session', sessionId: 'session-test-1' }, title: 'Send later: from an English device', prompt: 'english send', scheduledAt: new Date(Date.now() + 3600000).toISOString() },
    ],
  });
  win.localStorage.removeItem('dsh-send-later:v1:pending');
  await act(async () => { button.click(); });
  await act(async () => { await sleep(50); });
  check('a task titled with the English marker is adopted on this device too', () => assert.equal(badgeNode() && badgeNode().textContent, '1'));
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

  // 7. Prompt and preset are remembered across reopen.
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
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
  // Lifecycle (a): reopening after a success starts clean — the old confirmation is gone.
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check('reopened panel starts without the old confirmation', () => assert.ok(dialog && !dialog.textContent.includes('已排程，')));
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
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '自定义乙'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('a newer custom prompt replaces the snippet', () => assert.deepEqual(storeGet('dsh-send-later:v1:snippets'), ['自定义乙']));
  check('the strip still shows exactly two chips', () => assert.equal(
    qa('button svg[fill="currentColor"]', dialog).length, 2));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  await act(async () => { setValue(dialog.querySelector('input[type="text"]'), '继续'); });
  await act(async () => { findButton(dialog, '排程').click(); });
  check('the bare default prompt is not recorded as a snippet', () => {
    assert.deepEqual(storeGet('dsh-send-later:v1:snippets'), ['自定义乙']);
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
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
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

  // 11. Solid accent under the official theme (ink-paired brand-primary), tonal under skins.
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

  // 13. Custom-time default pre-fills from the GLM 5h reset (+2 min); nothing about quota is displayed.
  win.fetch = async () => ({ ok: true, json: async () => ({ providers: [
    { key: "glm", status: "ready", plan: { windows: [{ key: "5h", percent: 39, resetsAt: new Date(Date.now() + 7200000).toISOString() }] } },
    { key: "copilot", status: "ready" },
  ] }) });
  await act(async () => { button.click(); });
  dialog = dialogNode();
  check("no quota percent hint is displayed anywhere", () => assert.equal(
    dialogNode().querySelector('span[title^="GLM 5h"]'), null));
  const expected = new Date(Date.now() + 7200000 + 120000);
  const hmMatches = (input, when) => [0, -60000, 60000].some((delta) => input === hm(new Date(when.getTime() + delta)));
  await act(async () => { findButton(dialog, "指定").click(); });
  check("custom inputs pre-fill to the reset time plus two minutes", () => {
    assert.equal(dialog.querySelector('input[type="date"]').value, ymd(expected));
    assert.ok(hmMatches(dialog.querySelector('input[type="time"]').value, expected),
      `time was: ${dialog.querySelector('input[type="time"]').value}`);
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  delete win.fetch;
  await act(async () => { button.click(); });
  dialog = dialogNode();
  const fallback = new Date(Date.now() + 3600000);
  await act(async () => { findButton(dialog, "指定").click(); });
  check("without quota data the custom default stays one hour ahead", () => {
    assert.equal(dialog.querySelector('input[type="date"]').value, ymd(fallback));
    assert.ok(hmMatches(dialog.querySelector('input[type="time"]').value, fallback),
      `time was: ${dialog.querySelector('input[type="time"]').value}`);
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

  // W. Delivery watchdog (silent auto-redelivery via schedule/run). Every W scenario seeds its own
  // preconditions (catalog, run/edit stubs, budget ledger, panel state), so none depends on another.
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const resetWatchdog = (ledger) => {
    runCalls.length = 0;
    cancelCalls.length = 0;
    win.localStorage.clear();
    if (ledger !== undefined) win.localStorage.setItem('dsh-send-later:v1:nudges', JSON.stringify(ledger));
    nextRun = async () => ({ ok: true, value: {} });
    nextEdit = async (request) => { cancelCalls.push(request); return { ok: true, value: {} }; };
  };
  const closePanel = async () => {
    if (!dialogNode()) return;
    await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { await sleep(30); });
  };
  const openPanel = async () => {
    await closePanel();
    await act(async () => { button.click(); }); // a click on an open panel would toggle it shut
  };
  const stalledEntry = () => ({
    id: 'stall-1', status: 'active', kind: 'at',
    title: '延时发送：继续', prompt: '继续',
    scheduledAt: iso(15 * 60000),
    target: { kind: 'session', sessionId: 'session-test-1' },
  });
  // W1. A stalled delivery is nudged exactly once, through run, and the nudge is recorded.
  resetWatchdog();
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await openPanel(); // panel open → refreshPending → watchdog
  await act(async () => { await sleep(80); }); // nudge chain: fresh re-check + run
  check('watchdog nudges a stalled delivery exactly once', () => assert.equal(runCalls.length, 1));
  check('watchdog run targets the stalled task id', () => assert.deepEqual(runCalls[0], { id: 'stall-1' }));
  check('watchdog records the nudge budget', () => {
    const book = storeGet('dsh-send-later:v1:nudges');
    assert.equal(book['stall-1'].count, 1);
    assert.ok(typeof book['stall-1'].lastAt === 'number');
  });
  await closePanel();

  // W2. Gap guard: a nudge that landed moments ago blocks an immediate second one. The control
  // below proves the same task is nudged once the gap has passed, so the block is the gap guard.
  resetWatchdog({ 'stall-1': { count: 1, lastAt: Date.now() } });
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('gap guard suppresses an immediate second nudge', () => assert.equal(runCalls.length, 0));
  await closePanel();
  resetWatchdog({ 'stall-1': { count: 1, lastAt: Date.now() - 11 * 60000 } });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('control: the same task is nudged once the gap has passed', () => assert.equal(runCalls.length, 1));
  await closePanel();

  // W3. Budget cap: 3 recorded nudges stop auto-redelivery. The control (2 recorded, gap passed)
  // proves the same task is still nudged below the cap, so the block is the cap itself.
  resetWatchdog({ 'stall-1': { count: 3, lastAt: Date.now() - 11 * 60000 } });
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('budget cap stops automatic nudges', () => assert.equal(runCalls.length, 0));
  await closePanel();
  resetWatchdog({ 'stall-1': { count: 2, lastAt: Date.now() - 11 * 60000 } });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('control: one attempt below the cap is still allowed', () => assert.equal(runCalls.length, 1));
  await closePanel();

  // W4. Ownership, receipt and in-flight guards: only the owned, stalled control may be nudged.
  resetWatchdog();
  nextCatalog = async () => ({ ok: true, value: [
    { ...stalledEntry(), id: 'control-1' },
    { ...stalledEntry(), id: 'acked-1', lastDelivery: { scheduledAt: iso(15 * 60000), deliveredAt: iso(14 * 60000), messageId: 'm1', targetSessionId: 'session-test-1' } },
    { ...stalledEntry(), id: 'flying-1', executionActive: true },
    { ...stalledEntry(), id: 'foreign-1', title: '官方页手建任务', prompt: 'x' },
  ] });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('only the owned, stalled task is nudged; acknowledged, in-flight and foreign tasks are not', () => assert.deepEqual(
    runCalls.map((request) => request.id), ['control-1']));
  await closePanel();

  // W5. An archived destination short-circuits the watchdog: one attempt, then no more.
  resetWatchdog();
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  nextRun = async () => ({ ok: false, error: { code: 'schedule/target-archived', message: 'archived' } });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('archived error consumes one nudge', () => assert.equal(runCalls.length, 1));
  check('archived task is flagged to stop future nudges', () => {
    const book = storeGet('dsh-send-later:v1:nudges');
    assert.equal(book['stall-1'].archived, true);
  });
  await closePanel();
  // Phase 2 must isolate the archived flag as the ONLY suppressing force: reopen the panel
  // (a click while open would just toggle it shut) AND wind the gap clock outside the window,
  // otherwise the 10-minute gap guard masks the archived branch and the check stays vacuous.
  runCalls.length = 0;
  win.localStorage.setItem('dsh-send-later:v1:nudges', JSON.stringify({ 'stall-1': { count: 1, lastAt: Date.now() - 11 * 60000, archived: true } }));
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await openPanel();
  await act(async () => { await sleep(80); });
  check('archived task gets no further nudges even outside the gap window', () => assert.equal(runCalls.length, 0));
  await closePanel();
  resetWatchdog();

  // W6. An admitted run-now is retired: the task is deleted with the updatedAt the run returned.
  // (0.2.5: a run-now keeps the one-shot's occurrence on the Host, so it would deliver again.)
  resetWatchdog();
  const admittedRun = (id, at) => ({ ok: true, value: {
    id, status: 'active', scheduledAt: iso(15 * 60000), updatedAt: at,
    lastDelivery: { scheduledAt: at, deliveredAt: at, messageId: `m-${id}`, targetSessionId: 'session-test-1' },
    target: { kind: 'session', sessionId: 'session-test-1' },
  } });
  const at6 = new Date().toISOString();
  nextCatalog = async () => ({ ok: true, value: [{ ...stalledEntry(), id: 'admit-1' }] });
  nextRun = async () => admittedRun('admit-1', at6);
  nextEdit = async (request) => { cancelCalls.push(request); nextCatalog = async () => ({ ok: true, value: [] }); return { ok: true, value: {} }; }; // the host stops listing a deleted task
  await openPanel();
  await act(async () => { await sleep(120); });
  check('an admitted run-now is followed by exactly one delete', () => assert.equal(cancelCalls.length, 1));
  check('the delete carries the updatedAt that the run returned', () => assert.deepEqual(
    cancelCalls[0], { id: 'admit-1', action: 'delete', expectedUpdatedAt: at6 }));
  await closePanel();

  // W7. A refused run-now (execution pending) proves nothing was sent, so nothing is deleted.
  resetWatchdog();
  nextCatalog = async () => ({ ok: true, value: [{ ...stalledEntry(), id: 'refuse-1' }] });
  nextRun = async () => ({ ok: true, value: { id: 'refuse-1', code: 'schedule_execution_pending' } });
  await openPanel();
  await act(async () => { await sleep(120); });
  check('a refused run-now is not deleted', () => assert.equal(cancelCalls.length, 0));
  await closePanel();

  // W8. A delete the Host refuses as a conflict (the task changed after the run) is given up, not retried.
  resetWatchdog();
  const at8 = new Date().toISOString();
  nextCatalog = async () => ({ ok: true, value: [{ ...stalledEntry(), id: 'conflict-1' }] });
  nextRun = async () => admittedRun('conflict-1', at8);
  nextEdit = async (request) => { cancelCalls.push(request); return { ok: true, value: { id: request.id, code: 'schedule_conflict' } }; };
  await openPanel();
  await act(async () => { await sleep(120); });
  check('a conflicting delete is attempted once and not retried', () => assert.equal(cancelCalls.length, 1));
  await closePanel();

  // W9. A transient delete failure is retried on the retry cadence while the window is open.
  resetWatchdog();
  const at9 = new Date().toISOString();
  let deleteTries = 0;
  nextCatalog = async () => ({ ok: true, value: [{ ...stalledEntry(), id: 'retry-1' }] });
  nextRun = async () => admittedRun('retry-1', at9);
  nextEdit = async (request) => {
    cancelCalls.push(request);
    deleteTries += 1;
    if (deleteTries === 1) return { ok: false, error: { message: 'busy' } };
    nextCatalog = async () => ({ ok: true, value: [] }); // the host stops listing a deleted task
    return { ok: true, value: {} };
  };
  await openPanel();
  await act(async () => { await sleep(3600); });
  check('a failed delete is retried and then succeeds', () => assert.equal(deleteTries, 2));
  await closePanel();
  resetWatchdog();
  win.localStorage.removeItem('dsh-send-later:v1:nudges');

  // M. The pending merge, the watchdog policy and the watchdog module, driven directly with fake ports
  // (no DOM, no real timers). The component tests above prove the wiring; these pin each branch.
  const { mergePending, isStalled, dueNudges, applyAttempt, markArchived, isAdmittedRun, createWatchdog } = def.internals;
  const T0 = Date.parse('2026-11-10T06:00:00.000Z');
  const SID = 'session-test-1';
  const isoAt = (ms) => new Date(ms).toISOString();
  const stalled = (id, msAgo) => ({ id, status: 'active', kind: 'at', title: '延时发送：继续', prompt: '继续',
    scheduledAt: isoAt(T0 - msAgo), target: { kind: 'session', sessionId: SID } });
  const admitted = (id, at) => ({ id, status: 'active', scheduledAt: isoAt(T0 - 900000), updatedAt: at,
    lastDelivery: { scheduledAt: at, deliveredAt: at, messageId: `m-${id}`, targetSessionId: SID },
    target: { kind: 'session', sessionId: SID } });
  const okNoop = async () => ({ ok: true, value: {} });
  const fakeWatchdog = ({ catalog, run, cancel, persistFails = false }) => {
    const clock = { t: T0 };
    const log = { runs: [], cancels: [], books: [], sleeps: [] };
    const ports = {
      listCatalog: async () => ({ ok: true, value: catalog }),
      runTask: async (id) => { log.runs.push(id); return run(id); },
      cancelTask: async (id, expectedUpdatedAt) => {
        log.cancels.push({ id, expectedUpdatedAt });
        return cancel(id, expectedUpdatedAt, log.cancels.length);
      },
      persistBook: (book) => { if (persistFails) throw new Error('ledger unavailable'); log.books.push(book); },
      now: () => clock.t,
      sleep: async (ms) => { log.sleeps.push(ms); clock.t += ms; },
      isAlive: () => true,
    };
    return { watchdog: createWatchdog(ports), log };
  };

  const adopted = mergePending({ registry: [], catalog: [{ ...stalled('ad-1', 60000), title: '延时发送：自定义' }],
    sid: SID, markers: ['延时发送：'], now: T0 });
  check('pending merge adopts a catalog task by its title marker and owns it', () => {
    assert.deepEqual(adopted.pending.map((r) => r.id), ['ad-1']);
    assert.ok(adopted.owned.has('ad-1'));
    assert.equal(adopted.catalogAvailable, true);
  });

  check('the title markers cover both built-in languages (Q2)', () => assert.deepEqual(def.internals.titleMarkers, ['Send later: ', '延时发送：']));

  const lag = mergePending({ registry: [
    { id: 'lag-1', sessionId: SID, at: isoAt(T0), prompt: '刚排', ts: T0 - 29999 },
    { id: 'old-1', sessionId: SID, at: isoAt(T0), prompt: '过期', ts: T0 - 30000 },
  ], catalog: [], sid: SID, markers: ['延时发送：'], now: T0 });
  check('a just-created task the catalog does not list yet is shown but never owned, for 30 seconds (Q14)', () => {
    assert.deepEqual(lag.pending.map((r) => r.id), ['lag-1']);
    assert.equal(lag.owned.size, 0);
  });

  const ended = mergePending({ registry: [
    { id: 'e-1', sessionId: SID, at: isoAt(T0), prompt: '已结束', ts: T0 - 10000 },
  ], catalog: [{ ...stalled('e-1', 900000), status: 'ended' }], sid: SID, markers: ['延时发送：'], now: T0 });
  check('a send the catalog knows as ended is never shown from the registry alone (Q14)', () => {
    assert.deepEqual(ended.pending, []);
  });

  const unlisted = mergePending({ registry: [
    { id: 'l-60', sessionId: SID, at: isoAt(T0), prompt: '一分钟前', ts: T0 - 60000 },
  ], catalog: [], sid: SID, markers: ['延时发送：'], now: T0 });
  check('a send the catalog has not listed for over 30 seconds is no longer shown (Q14)', () => {
    assert.deepEqual(unlisted.pending, []);
  });

  const offline = mergePending({ registry: [
    { id: 'off-1', sessionId: SID, at: isoAt(T0), prompt: '离线', ts: T0 },
    { id: 'other-2', sessionId: 'session-other', at: isoAt(T0), prompt: '别处', ts: T0 },
  ], catalog: undefined, sid: SID, markers: ['延时发送：'], now: T0 });
  check("an unavailable catalog falls back to this session's registry rows and owns nothing", () => {
    assert.deepEqual(offline.pending.map((r) => r.id), ['off-1']);
    assert.equal(offline.owned.size, 0);
    assert.equal(offline.catalogAvailable, false);
  });

  check('stalled is state only: past its target time, no grace', () => assert.equal(isStalled(stalled('s-1', 60000), T0), true));
  const policyEntries = [stalled('g-young', 60000), stalled('g-old', 600000), stalled('g-capped', 600000),
    stalled('g-gap', 600000), stalled('g-arch', 600000)];
  check('the policy layers grace, gap, cap and archived over the stalled state', () => {
    const book = {
      'g-capped': { count: 3, lastAt: T0 - 600000 },
      'g-gap': { count: 1, lastAt: T0 - 1000 },
      'g-arch': { count: 1, lastAt: T0 - 600000, archived: true },
    };
    assert.deepEqual(dueNudges({ entries: policyEntries, owned: new Set(policyEntries.map((e) => e.id)), book, now: T0 }), ['g-old']);
  });

  const r5 = fakeWatchdog({ catalog: [stalled('r-1', 900000)], run: async () => ({ ok: true, value: admitted('r-1', isoAt(T0)) }), cancel: okNoop });
  const o5 = await r5.watchdog.scan({ entries: [stalled('r-1', 900000)], owned: new Set(['r-1']), book: {} });
  check('an admitted run-now is retired with the updatedAt the run returned', () => {
    assert.deepEqual(o5.map((o) => o.outcome), ['retired']);
    assert.deepEqual(r5.log.cancels, [{ id: 'r-1', expectedUpdatedAt: isoAt(T0) }]);
  });
  check('the attempt reaches the ledger before the run, and the ledger counts it', () => assert.equal(r5.log.books[0]['r-1'].count, 1));

  const r6 = fakeWatchdog({ catalog: [stalled('f-1', 900000)],
    run: async () => ({ ok: true, value: { id: 'f-1', code: 'schedule_execution_pending' } }), cancel: okNoop });
  const o6 = await r6.watchdog.scan({ entries: [stalled('f-1', 900000)], owned: new Set(['f-1']), book: {} });
  check('a refused run-now is outcome refused and never deleted', () => {
    assert.deepEqual(o6.map((o) => o.outcome), ['refused']);
    assert.equal(r6.log.cancels.length, 0);
  });

  const r7 = fakeWatchdog({ catalog: [stalled('a-1', 900000)],
    run: async () => ({ ok: false, error: { code: 'schedule/target-archived' } }), cancel: okNoop });
  const o7 = await r7.watchdog.scan({ entries: [stalled('a-1', 900000)], owned: new Set(['a-1']), book: {} });
  check('an archived destination is outcome archived and its ledger entry is flagged', () => {
    assert.deepEqual(o7.map((o) => o.outcome), ['archived']);
    assert.equal(r7.log.books[r7.log.books.length - 1]['a-1'].archived, true);
  });

  const delivered8 = { ...stalled('k-1', 900000),
    lastDelivery: { scheduledAt: isoAt(T0), deliveredAt: isoAt(T0), messageId: 'm-k', targetSessionId: SID } };
  const r8 = fakeWatchdog({ catalog: [delivered8], run: async () => ({ ok: true, value: {} }), cancel: okNoop });
  const o8 = await r8.watchdog.scan({ entries: [stalled('k-1', 900000)], owned: new Set(['k-1']), book: {} });
  check('a task delivered between the scan and the re-check is skipped, not run', () => {
    assert.deepEqual(o8.map((o) => o.outcome), ['skipped']);
    assert.equal(r8.log.runs.length, 0);
  });

  const r9 = fakeWatchdog({ catalog: [stalled('c-1', 900000)], run: async () => ({ ok: true, value: admitted('c-1', isoAt(T0)) }),
    cancel: async () => ({ ok: true, value: { id: 'c-1', code: 'schedule_conflict' } }) });
  const o9 = await r9.watchdog.scan({ entries: [stalled('c-1', 900000)], owned: new Set(['c-1']), book: {} });
  check('a conflicting delete is given up after one attempt', () => {
    assert.deepEqual(o9.map((o) => o.outcome), ['conflict']);
    assert.equal(r9.log.cancels.length, 1);
  });

  const r10 = fakeWatchdog({ catalog: [stalled('t-1', 900000)], run: async () => ({ ok: true, value: admitted('t-1', isoAt(T0)) }),
    cancel: async (id, at, attempt) => (attempt === 1 ? { ok: false, error: { message: 'busy' } } : { ok: true, value: {} }) });
  const o10 = await r10.watchdog.scan({ entries: [stalled('t-1', 900000)], owned: new Set(['t-1']), book: {} });
  check('a transient delete failure is retried on the 3 s cadence and then succeeds', () => {
    assert.deepEqual(o10.map((o) => o.outcome), ['retired']);
    assert.equal(r10.log.cancels.length, 2);
    assert.deepEqual(r10.log.sleeps, [3000]);
  });

  const r11 = fakeWatchdog({ catalog: [stalled('w-1', 900000)], run: async () => ({ ok: true, value: admitted('w-1', isoAt(T0)) }),
    cancel: async () => ({ ok: false, error: { message: 'down' } }) });
  const o11 = await r11.watchdog.scan({ entries: [stalled('w-1', 900000)], owned: new Set(['w-1']), book: {} });
  check('retries stop when the 55 s window closes: 19 attempts on the 3 s cadence', () => {
    assert.deepEqual(o11.map((o) => o.outcome), ['window-closed']);
    assert.equal(r11.log.cancels.length, 19);
  });

  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  const r12 = fakeWatchdog({ catalog: [stalled('i-1', 900000)],
    run: async () => { await runGate; return { ok: true, value: { id: 'i-1', code: 'schedule_execution_pending' } }; }, cancel: okNoop });
  const entries12 = [stalled('i-1', 900000)];
  const firstScan = r12.watchdog.scan({ entries: entries12, owned: new Set(['i-1']), book: {} });
  const secondScan = r12.watchdog.scan({ entries: entries12, owned: new Set(['i-1']), book: {} });
  releaseRun(); // release only after both scans have started, so a broken guard shows up as a failure, not a hang
  const secondOutcomes = await secondScan;
  const firstOutcomes = await firstScan;
  check('overlapping scans nudge a task at most once: a second scan starts nothing while one is in flight', () => {
    assert.deepEqual(secondOutcomes, []);
    assert.equal(r12.log.runs.length, 1);
    assert.deepEqual(firstOutcomes.map((o) => o.outcome), ['refused']);
  });

  const c1 = fakeWatchdog({ catalog: [{ ...stalled('c1-1', 900000), lastDelivery: { scheduledAt: isoAt(T0), deliveredAt: isoAt(T0), messageId: 'm-c1', targetSessionId: SID } }],
    run: async () => ({ ok: true, value: {} }), cancel: okNoop });
  const oc1 = await c1.watchdog.scan({ entries: [stalled('c1-1', 900000)], owned: new Set(['c1-1']), book: {} });
  check('a re-check that finds the task already delivered is skipped and spends no budget (Q21)', () => {
    assert.deepEqual(oc1.map((o) => o.outcome), ['skipped']);
    assert.equal(c1.log.books.length, 0);
  });

  const c2 = fakeWatchdog({ catalog: [stalled('p-1', 900000)], run: async () => ({ ok: true, value: {} }), cancel: okNoop, persistFails: true });
  const oc2 = await c2.watchdog.scan({ entries: [stalled('p-1', 900000)], owned: new Set(['p-1']), book: {} }).catch((error) => ({ thrown: error }));
  check('if the attempt cannot be recorded, nothing is sent (Q21)', () => {
    assert.equal(oc2.thrown, undefined);
    assert.deepEqual(oc2.map((o) => o.outcome), ['skipped']);
    assert.equal(c2.log.runs.length, 0);
  });

  const c3 = fakeWatchdog({ catalog: [stalled('q-1', 900000)], run: async () => ({ ok: true, value: admitted('q-1', isoAt(T0)) }), cancel: okNoop });
  await c3.watchdog.scan({ entries: [stalled('q-1', 900000)], owned: new Set(['q-1']), book: {} });
  check('a retired task leaves no ledger entry behind (Q24)', () => assert.equal('q-1' in c3.log.books[c3.log.books.length - 1], false));

  check('forgetting a retired task returns a new ledger without its entry (Q24)', () => {
    const before = { a: { count: 1, lastAt: 5 }, c: { count: 2, lastAt: 6 } };
    assert.deepEqual(def.internals.forgetNudge(before, 'a'), { c: { count: 2, lastAt: 6 } });
    assert.ok('a' in before);
  });

  check('ledger updates are pure: applyAttempt and markArchived return a new book', () => {
    const before = { a: { count: 1, lastAt: 5 } };
    assert.deepEqual(applyAttempt(before, 'a', 9).a, { count: 2, lastAt: 9 });
    assert.deepEqual(before.a, { count: 1, lastAt: 5 });
    assert.equal(markArchived(before, 'b', 7).b.archived, true);
  });

  check('an admitted run-now is told apart from a refusal', () => {
    assert.equal(isAdmittedRun(admitted('x1', isoAt(T0)), 'x1'), true);
    assert.equal(isAdmittedRun({ id: 'x1', code: 'schedule_execution_pending' }, 'x1'), false);
  });

  // 14. No JavaScript errors from the module itself.
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
