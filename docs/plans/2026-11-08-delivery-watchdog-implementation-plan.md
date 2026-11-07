# 投递看门狗（静默补投）实施计划

## 目标

为 dsh-send-later v0.2.3 增加**全静默投递看门狗**：当一条本插件的延时发送任务「搁浅」（已过目标时刻、无投递回执、非投递进行中）时，客户端通过官方 `schedule/run` 通道对**原任务**发起补投（不新建任务、不移动原定时刻），按预算自动重试（首补逾期 ≥5 分钟、间隔 ≥10 分钟、每任务 ≤3 次、归档目的地短路）。零新增用户可见 UI；手动兜底由官方自动化任务页既有「立即执行」承担。

## 架构快照

- **宿主事实（设计依据，已对源码核实）**：`drive()` 投递失败的任务被排除出定时器计算（`failed` set），任务保持 `active` 但宿主不再为它排任何重试定时器，只等下一次无关 schedule 事件——这是看门狗填的空窗。`schedule/run`（`api.run({id})`）在 `@deepseek-ai/dsh-api-remotes@0.2.2-rc.1` 已存在，`engines.dsh >= 0.2.2-rc.1` 声明不变。
- **双发防线（两层）**：宿主 admission floor（回执 +60s 内 `run` 返回 `admitted:false`）+ 客户端补投前强制重拉目录复核（`runNow` 不检查任务是否已结束，快照陈旧是唯一双发窗口，复核把它压到毫秒级残差，接受并留档）。
- **挂载点**：看门狗扫描挂在组件既有的 `refreshPending`（目录轮询）末尾；新增一条 60s 心跳 interval 让「面板关闭且有待发」时也持续巡检（此前面板关闭不轮询——这是本特性新增的后台成本，刻意为之）。
- **记账**：`localStorage` 新键 `dsh-send-later:v1:nudges`，结构 `{[taskId]: {count, lastAt, archived?}}`；清空后预算从零重计（共识 R1–R4）。
- **归档短路**：`run` 结果 `{ok:false, error.code === 'schedule/target-archived'}`（`RemoteError` 按 `code` 判别，稳定字面量）→ 该任务标记 `archived`，永久停止自动补投。
- **衔接**：不动面板行渲染、不加 locale 字符串（运行时文案是 client.js 内联字典，本次零新增）、不动角标语义、不动 awesome-dsh 投稿（PR #13061）。

## 全局约束

- 版本 **0.2.3**（owner 指定；不取 0.3.0）。
- **全静默**：不新增任何按钮、状态字、提示、locale 键；失败与预算耗尽都不弹提示。
- 节奏逐字：`NUDGE_GRACE_MS = 5 分钟`、`NUDGE_GAP_MS = 10 分钟`、`NUDGE_MAX = 3`；`ARCHIVED_CODE = 'schedule/target-archived'`。
- 作用域：仅当前会话**且归属本插件**的任务（registry id 匹配，或标题前缀「延时发送：」；⚠️ client.js 现有 `isOurs` 只判会话匹配不判归属——归属判定散在 `refreshPending` 两个循环里，看门狗扫描必须用其收集的 owned 集合，见 Task 2 Step 5 与场景 14 的 foreign 用例）。
- 补投只走 `schedule/run`，**禁止新建任务**；补投前必须重拉目录复核。
- `engines.dsh >= 0.2.2-rc.1`、`peerDependencies["@deepseek-ai/cordis"] ^4.0.2`、零 runtime dependencies、MIT、`publishConfig.registry` 官方源——全部不变。守卫面如实划分：`scripts/check-public-package.mjs` 机器断言 5 项（name / 零 runtime dependencies / cordis 已声明 / publishConfig.registry / MIT）；`engines.dsh` 版本与 cordis `^4.0.2` 精确范围**不在该脚本断言面内**，属人工不变量，由 Task 4 Step 2 的读回探针逐字核验。
- 平台：Linux（Host A，/home/ubuntu）、bash；仓库惯例为 **main 直接提交 + tag 发版**（0.2.x 先例，owner 已在 R4 共识确认）。

## 输入工件

- 设计共识：本会话 `/grill-with-docs` 两轮（R1 全静默 / R2 节奏维持 / R3 当前会话 / R4 发布范围维持；版本 0.2.3）。
- 术语表：`GLOSSARY.md`（仓库根，随共识落盘）。
- 宿主源码事实锚点：`@deepseek-ai/dsh-schedule@0.2.2-rc.1` `lib/index.js` `drive()`/`deliverDue()`/`runNow()`；`@deepseek-ai/dsh-api-remotes@0.2.2-rc.1` `schedule/run` face。

## 文件结构与职责

- Create: 无（GLOSSARY.md 已随共识落盘）。
- Modify: `client.js` —— 常量与记账 helper（`STORE_SNIPPETS` 常量块之后）、纯判定函数（`loadRegistry()` 附近）、slot 注入新增 `runTask`（`cancelTask` 行之后）、组件内 `nudge` 执行器 + `refreshPending` 末尾扫描 + 心跳 effect（既有 60s 面板轮询 effect 之后）。
- Modify: `test/run.cjs` —— `makeCtx` 桩加 `run`、exposed-api 断言加一行、追加 5 个看门狗场景（插在 `// 11. No JavaScript errors from the module itself.` 之前，原 11 号注释改为 `// 16.`——现存文件已有两个 12 号注释，避免三撞）。
- Modify: `package.json`（0.2.3）、`package-lock.json`（第 3、9 行两处根版本字段，0.2.2→0.2.3）、`CHANGELOG.md`（新增 `## 0.2.3` 节）、`README.md`（「可靠投递」bullet 与「已知限制」第一条改写）。
- Test: `test/run.cjs`（唯一测试入口，`npm test` 直跑 node，jsdom + React 19 行为测试）。
- 跨仓（独立收尾）：`~/workspace/dsh-m/registry.json` 的 `dsh-send-later` 条目（Task 6，owner 过目后另行 push）。

## 环境前提

- Node ≥20、bash（仓库 CI 用 node 24，本机 node 可用即等价）。
- 依赖恢复：`test -d node_modules || npm ci`；跑联网 npm 命令前按 `01_docs/agent-ops/README.md`「npm 调用」节把 `npm_config_cache` 指到 workspace 内路径（首选 `.dsh-research` 子路径）。

## 任务清单

### Task 1: 测试先行——桩扩展与看门狗场景（RED）

- 目标：把看门狗的验收标准写成 jsdom 行为测试；实现前跑出明确红灯。
- 涉及文件：`test/run.cjs`
- 接口契约
  - Consumes: 既有 `makeCtx`/`slot.inject`/`nextCatalog`/`storeGet` 桩与场景范式（场景 4 的前缀收养模式）。
  - Produces: 桩 `runCalls: []`、`nextRun`（可换脚本返回值）；9 个新 check（分布于 5 个场景块，编号 11–15）；client 侧契约「`inj.runTask` 为函数、收到 `{id}` 调用、记账键 `dsh-send-later:v1:nudges`」由 Task 2 满足。
- 验证范围：本任务结束时 `npm test` 必须红（见 Step 2 Expected）。

- [ ] Step 1: 桩扩展——`const cancelCalls = []` 之后加 `const runCalls = []; let nextRun = async () => ({ ok: true, value: {} });`；`makeCtx` 的 `ctx.remote.schedule` 加 `run: (request) => { runCalls.push(request); return nextRun(); }`；`face on: full api is exposed` check 内加 `assert.equal(typeof inj.runTask, 'function');`
- [ ] Step 2: 追加场景块（插在 `// 11. No JavaScript errors from the module itself.` 之前，并把该注释改为 `// 16. No JavaScript errors from the module itself.`——现存文件已存在两个 12 号注释，避免三撞）。场景代码逐字如下：

```js
  // 11. Delivery watchdog (silent auto-redelivery via schedule/run).
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const stalledEntry = () => ({
    id: 'stall-1', status: 'active', kind: 'at',
    title: '延时发送：继续', prompt: '继续',
    scheduledAt: iso(15 * 60000),
    target: { kind: 'session', sessionId: 'session-test-1' },
  });
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  win.localStorage.clear();
  await act(async () => { button.click(); }); // panel open → refreshPending → watchdog
  await act(async () => { await sleep(80); }); // nudge chain: fresh re-check + run
  check('watchdog nudges a stalled delivery exactly once', () => assert.equal(runCalls.length, 1));
  check('watchdog run targets the stalled task id', () => assert.deepEqual(runCalls[0], { id: 'stall-1' }));
  check('watchdog records the nudge budget', () => {
    const book = storeGet('dsh-send-later:v1:nudges');
    assert.equal(book['stall-1'].count, 1);
    assert.ok(typeof book['stall-1'].lastAt === 'number');
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await sleep(30); });

  // 12. Budget spacing: a poll right after a nudge must not re-nudge.
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(80); });
  check('gap guard suppresses an immediate second nudge', () => assert.equal(runCalls.length, 1));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await sleep(30); });

  // 13. Budget cap: 3 recorded nudges stop auto-redelivery.
  win.localStorage.setItem('dsh-send-later:v1:nudges', JSON.stringify({ 'stall-1': { count: 3, lastAt: Date.now() - 11 * 60000 } }));
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(80); });
  check('budget cap stops automatic nudges', () => assert.equal(runCalls.length, 1));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await sleep(30); });

  // 14. Ownership, receipt and in-flight guards: none of these may be nudged.
  nextCatalog = async () => ({ ok: true, value: [
    { ...stalledEntry(), id: 'acked-1', lastDelivery: { scheduledAt: iso(15 * 60000), deliveredAt: iso(14 * 60000), messageId: 'm1', targetSessionId: 'session-test-1' } },
    { ...stalledEntry(), id: 'flying-1', executionActive: true },
    { ...stalledEntry(), id: 'foreign-1', title: '官方页手建任务', prompt: 'x' },
  ] });
  win.localStorage.removeItem('dsh-send-later:v1:nudges');
  await act(async () => { button.click(); });
  await act(async () => { await sleep(80); });
  check('acknowledged, in-flight and foreign tasks are not nudged', () => assert.equal(runCalls.length, 1));
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await sleep(30); });

  // 15. Archived destination short-circuits the watchdog.
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  nextRun = async () => ({ ok: false, error: { code: 'schedule/target-archived', message: 'archived' } });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(80); });
  check('archived error consumes one nudge', () => assert.equal(runCalls.length, 2));
  check('archived task is flagged to stop future nudges', () => {
    const book = storeGet('dsh-send-later:v1:nudges');
    assert.equal(book['stall-1'].archived, true);
  });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await act(async () => { await sleep(30); });
  // Phase 2 must isolate the archived flag as the ONLY suppressing force: reopen the panel
  // (a click while open would just toggle it shut) AND wind the gap clock outside the window,
  // otherwise the 10-minute gap guard masks the archived branch and the check stays vacuous.
  win.localStorage.setItem('dsh-send-later:v1:nudges', JSON.stringify({ 'stall-1': { count: 1, lastAt: Date.now() - 11 * 60000, archived: true } }));
  nextCatalog = async () => ({ ok: true, value: [stalledEntry()] });
  await act(async () => { button.click(); });
  await act(async () => { await sleep(80); });
  check('archived task gets no further nudges even outside the gap window', () => assert.equal(runCalls.length, 2));
  nextRun = async () => ({ ok: true, value: {} });
  await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  win.localStorage.removeItem('dsh-send-later:v1:nudges');
```

- Run: `cd ~/workspace/dsh-send-later && npm test`
- Expected: **退出码 1**；`face on: full api is exposed` 与场景 11/12/13/14/15 全部 FAIL（`inj.runTask` undefined、`runCalls` 恒 0）；既有场景仍 PASS。
- 注：心跳 interval（60s）不做独立行为断言（jsdom 计时器成本高）——其扫描链路与场景 11 完全共用，由代码评审覆盖。

### Task 2: client.js 看门狗实现（GREEN）

- 目标：常量、记账、纯判定、`runTask` 注入、补投执行器、扫描挂载、心跳轮询。
- 涉及文件：`client.js`
- 接口契约
  - Consumes: Task 1 的桩与场景（`runCalls`/`nextRun`/记账键名）；既有 `loadStored`/`storeValue`/`propsRef`/`refreshPending`/`isOurs`。
  - Produces: inject props 新增 `runTask: (id) => Promise<RemoteResult>`；记账 schema `{[taskId]: {count:number, lastAt:number, archived?:true}}`；符号 `STORE_NUDGES`、`NUDGE_GRACE_MS`、`NUDGE_GAP_MS`、`NUDGE_MAX`、`ARCHIVED_CODE`、`loadNudges`、`recordNudge`、`markArchived`、`isStalledDelivery`、`autoNudgeDue`、`nudge`（后文 README/CHANGELOG 措辞引用行为，不再引用符号）。
- 验证范围：Task 1 全部场景转绿；既有场景零回归。

- [ ] Step 1: 常量——`const STORE_SNIPPETS = 'dsh-send-later:v1:snippets';` 之后加：

```js
    const STORE_NUDGES = 'dsh-send-later:v1:nudges';
    // Watchdog cadence: first nudge once a send is 5 minutes past due, then every 10 minutes,
    // at most 3 automatic nudges per task. Manual redelivery stays in the official page.
    const NUDGE_GRACE_MS = 5 * 60000;
    const NUDGE_GAP_MS = 10 * 60000;
    const NUDGE_MAX = 3;
    const ARCHIVED_CODE = 'schedule/target-archived';
```

- [ ] Step 2: 记账与纯判定——`loadRegistry()` 函数之后加：

```js
    /** Per-task watchdog bookkeeping: { [taskId]: { count, lastAt, archived? } }. Best-effort memory. */
    function loadNudges() {
      return loadStored(STORE_NUDGES, (v) => v && typeof v === 'object' && !Array.isArray(v)) ?? {};
    }
    function recordNudge(id, now) {
      const map = loadNudges();
      const book = map[id] && typeof map[id] === 'object' ? map[id] : {};
      map[id] = { count: (typeof book.count === 'number' ? book.count : 0) + 1, lastAt: now };
      storeValue(STORE_NUDGES, map);
    }
    function markArchived(id) {
      const map = loadNudges();
      const book = map[id] && typeof map[id] === 'object' ? map[id] : {};
      map[id] = { count: typeof book.count === 'number' ? book.count : 0, lastAt: typeof book.lastAt === 'number' ? book.lastAt : Date.now(), archived: true };
      storeValue(STORE_NUDGES, map);
    }
    /** A delivery the Host stopped driving: still active, past due by the grace window,
     * nothing in flight, and no delivery was ever acknowledged. */
    function isStalledDelivery(entry, now) {
      return Boolean(entry && entry.status === 'active'
        && typeof entry.scheduledAt === 'string'
        && !entry.executionActive
        && entry.lastDelivery === undefined
        && Number.isFinite(Date.parse(entry.scheduledAt))
        && Date.parse(entry.scheduledAt) + NUDGE_GRACE_MS <= now);
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
```

- [ ] Step 3: 组件 refs——`const pendingRef = useRef([]);` 行之后加 `const nudgingRef = useRef(new Set());`
- [ ] Step 4: 补投执行器——`refreshPending` 定义之前加（函数声明提升，`refreshPending` 调用时 `nudgingRef` 已初始化）：

```js
    /** Nudge one stalled task through the official run-now face. Re-reads the catalog first so a
     * task the Host just delivered itself is never delivered twice (run-now has no ended guard). */
    async function nudge(id) {
      const props = propsRef.current;
      try {
        if (typeof props.runTask !== 'function' || typeof props.listCatalog !== 'function') return;
        const result = await props.listCatalog();
        const entries = result && result.ok ? result.value : undefined;
        const entry = Array.isArray(entries) ? entries.find((candidate) => candidate && candidate.id === id) : undefined;
        if (!isStalledDelivery(entry, Date.now())) return;
        const outcome = await props.runTask(id);
        if (outcome && outcome.ok === false && outcome.error && outcome.error.code === ARCHIVED_CODE) {
          markArchived(id);
        }
      } catch (_error) {
        /* silent: the next poll retries within budget */
      } finally {
        nudgingRef.current.delete(id);
      }
    }
```

- [ ] Step 5: 扫描挂载（两处小改 + 一段插入）——①`refreshPending` 内 `const seen = new Set();` 行之后加 `const owned = new Set(); // catalog entries this session owns (registry id or title prefix) — NOT bare isOurs, which only matches the session`；②归属两循环各加一行收集——⚠️ `seen.add(r.id);` 在 client.js 出现两处（≈L431 registry 匹配循环、≈L448 catalog-lag 兜底循环，文本全同，加错到 448 会使「registry 命中但标题已改」的任务静默漏出补投作用域，且现场景全带前缀测不出），必须以其上一行 `live.push` 定位：在紧跟 `live.push({ id: r.id, at: entry.scheduledAt || r.at, prompt: typeof entry.prompt === 'string' ? entry.prompt : r.prompt || '' });` 之后的 `seen.add(r.id);` 行后加 `owned.add(r.id);`（`at: entry.scheduledAt || r.at` 是该循环唯一特征——lag 循环形如 `at: r.at`）；前缀收养循环的 `seen.add(entry.id);`（全文件唯一）后加 `owned.add(entry.id);`；③`storeValue(STORE_PENDING, live.map(...))` 行之后（仍在 `Array.isArray(entries)` 分支内，`now` 已在作用域）加：

```js
        // Delivery watchdog (silent): the Host timer loop drops failed one-shots, so a stalled
        // task can wait forever for the next unrelated schedule event. Nudge it via run-now
        // on a per-task budget; manual redelivery stays in the official automation page.
        // Scope = owned only (registry id or title prefix): the session's other active tasks
        // (e.g. hand-created in the official automation page) are never touched.
        const nudges = loadNudges();
        for (const entry of entries) {
          if (!owned.has(entry.id) || nudgingRef.current.has(entry.id)) continue;
          if (!isStalledDelivery(entry, now) || !autoNudgeDue(entry, nudges, now)) continue;
          nudgingRef.current.add(entry.id);
          recordNudge(entry.id, now);
          void nudge(entry.id);
        }
```

- [ ] Step 6: slot 注入——slot `inject` 返回对象的 `cancelTask: (id) => api.edit({ id, action: 'delete' }),` 行之后加 `runTask: (id) => api.run({ id }),`
- [ ] Step 7: 心跳——既有 60s 面板轮询 `useEffect` 之后加：

```js
      // Watchdog heartbeat: the stalled-delivery scan rides the same catalog poll the open
      // panel already pays; keep one light tick while the panel is closed and sends are pending.
      useEffect(() => {
        const id = window.setInterval(() => {
          if (aliveRef.current && !openRef.current && pendingRef.current.length > 0) refreshPending();
        }, 60000);
        return () => window.clearInterval(id);
      }, []);
```

- Run: `npm test && node --check client.js && node --check index.js`
- Expected: 退出码 0，输出 `N/N passed`（Task 1 新场景全绿 + 既有场景零回归）。

### Task 3: 版本与文档（0.2.3）

- 目标：版本三处同步（031 纪律）、CHANGELOG、README 两处措辞更新。
- 涉及文件：`package.json`、`package-lock.json`（根 `version` 两处）、`CHANGELOG.md`、`README.md`
- 接口契约
  - Consumes: Task 2 定稿的行为（节奏数字、归档短路、静默语义）。
  - Produces: 可发布版本 0.2.3（publish.yml 以 package.json 版本出包）。
- 验证范围：`npm run security:check` 仍绿；README 与实现行为逐字一致。

- [ ] Step 1: `package.json` `"version": "0.2.2"` → `"0.2.3"`；`package-lock.json` 两处 `"version": "0.2.2"`（根与 `packages[""]`）→ `"0.2.3"`
- [ ] Step 2: `CHANGELOG.md` 顶部（`# Changelog` 之后）加：

```md
## 0.2.3

Silent delivery watchdog: when a scheduled send sits overdue with no delivery receipt (the Host timer loop drops failed one-shots), the plugin nudges the original task through the official run-now channel — up to 3 automatic redeliveries per task, 10 minutes apart, first attempt 5 minutes past due; archived destinations stop the nudging. No new UI; manual run-now stays in the official automation tasks page.
```

- [ ] Step 3: `README.md`「可靠投递」bullet 整行替换为：

```md
- **可靠投递**：投递依托 DSH 官方自动化任务（`schedule`），任务持久化、重启不丢；到点未确认的投递（额度未恢复、宿主拒绝等）由插件在后台自动补投——仍是同一条官方任务（默认最多 3 次、间隔 10 分钟，网页打开期间生效），「自动化任务」页可随时查看、暂停、删除或手动立即执行。
```

- [ ] Step 4: `README.md`「已知限制」第一条整行替换为：

```md
- 到点时若模型额度尚未恢复，该次投递无法推动会话继续；插件会在网页打开期间自动补投（≤3 次、间隔 10 分钟），额度恢复后的首次补投即续跑。关闭所有网页期间错过的补投窗口，重新打开页面后仍会检测并补投。
```

- Run: `npm run security:check && npm pack --dry-run --json > /dev/null && echo PACK_OK`
- Expected: `check-public-package: ok` 与 `PACK_OK`（依赖面零变化，新版本可打包）。

### Task 4: 全量本地验证（CI 镜像）

- 目标：复现 ci.yml 与 publish.yml 的四个门槛，全部绿后再出仓。
- 涉及文件：无改动（纯验证）。
- 接口契约
  - Consumes: Task 1–3 的全部产物。
  - Produces: 发布前置条件的通过证据。
- 验证范围：与 CI 逐字同集。

- [ ] Step 1: `npm ci && npm test && node --check client.js && node --check index.js && npm run security:check && npm pack --dry-run --json > /dev/null && echo ALL_GREEN`
- Expected: `ALL_GREEN`，退出码 0。
- [ ] Step 2: 不变量读回探针（把 guard 脚本不覆盖的人工不变量变成可观测判据）：`node -e "const p=require('./package.json'); if(p.version!=='0.2.3')process.exit(1); if(p.dsh?.engines?.dsh!=='>=0.2.2-rc.1')process.exit(1); if(p.peerDependencies['@deepseek-ai/cordis']!=='^4.0.2')process.exit(1); if(p.dsh?.client?.platform!=='web')process.exit(1); console.log('INVARIANTS_OK')"`
- Expected: 输出 `INVARIANTS_OK`，退出码 0（任一不变量漂移即非零退出，终止发布）。

### Task 5: 提交、tag、发布与上架确认

- 目标：main 两段式提交（先代码后版本）、tag 触发 publish.yml、确认 npm 真实上架（018 纪律：绿 ≠ 上架）。
- 涉及文件：git 仓库状态（无新文件改动）。
- 接口契约
  - Consumes: Task 4 的 ALL_GREEN。
  - Produces: npm 上架 `dsh-send-later@0.2.3`；远端 tag `v0.2.3`。
- 验证范围：workflow 绿 + registry 直查 200。

- [ ] Step 1: `git add client.js test/run.cjs && git commit -m "feat: silent delivery watchdog (official run-now redelivery, budget 3x/10min, archived short-circuit)"`
- [ ] Step 2: `git add package.json package-lock.json CHANGELOG.md README.md && git commit -m "0.2.3"`
- [ ] Step 3: `git push origin main && git tag v0.2.3 && git push origin v0.2.3`
- [ ] Step 4: 发布监视（018 两阶段纪律）：`bash ~/workspace/01_docs/dsh-intall-know-how/tools/release-monitor.sh iasiv5/dsh-send-later v0.2.3 dsh-send-later 0.2.3`
- 注：监视脚本超时或报失败即停并回报——OIDC staged 窗口内（dsh-skins 实测可长达 ~1h）**不重推 tag、不重跑 publish**（018 铁律：绿 ≠ 上架，以 registry 直查为终审）。
- [ ] Step 5: 上架终验：`curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/dsh-send-later/0.2.3` → `200`
- Expected: workflow 绿、脚本三键轮询通过、registry 直查 200。

### Task 6: dsh-m registry 条目复核（owner gate，跨仓收尾）

- 目标：`~/workspace/dsh-m/registry.json` 的 `dsh-send-later` 条目与 0.2.3 保持一致；**push 前必须 owner 过目**（008 纪律）。
- 涉及文件：`~/workspace/dsh-m/registry.json`（仅该条目）
- 接口契约
  - Consumes: Task 5 的 npm 200。
  - Produces: registry 主人确认后的推送（独立于本仓发布）。
- 验证范围：`validate-registry` 零警告。

- [ ] Step 1: 拟改动——条目 `description` 句中「到点自动发进当前会话」之后增补「投递失败自动补投（官方 run-now，静默 ≤3 次）」；`verified` **不动**（只记 DSH 运行时版本，022 纪律；0.2.3 不改 `engines.dsh` 兼容线）
- [ ] Step 2: 向 owner 出示 diff 等待确认；**未确认不 push**
- [ ] Step 3: 确认后 `cd ~/workspace/dsh-m && node scripts/validate-registry.mjs`（若遇 GitHub API 限额，按 know-how 索引「快速定位补充」export `GITHUB_TOKEN=$(gh auth token)` 重跑），零警告后 push
- Expected: validate 全绿、diff 与 owner 确认内容逐字一致。

## 执行纪律

- 开始实现前批判性复查整份计划；发现缺项、矛盾或验证命令无效，先修计划再动手。
- 按任务顺序执行；不无声跳步、合并步或改变任务目标。
- 每完成一个任务跑该任务定义的验证；红灯即停，不猜。
- 本仓惯例为 main 直接提交 + tag 发版（0.2.x 先例），owner 已在 R4 共识确认沿用；除此之外不另开分支。
- 全部任务完成后运行最终验证并输出修改摘要。

## 最终验证

- 本仓：`npm ci && npm test && node --check client.js && node --check index.js && npm run security:check && npm pack --dry-run --json > /dev/null && echo ALL_GREEN` → 退出码 0。
- 发布面：publish.yml workflow 绿；`https://registry.npmjs.org/dsh-send-later/0.2.3` → 200。
- 跨仓：dsh-m `validate-registry` 零警告（owner 确认后）。
- 实装冒烟（owner 浏览器侧，非本计划阻塞项）：升级到 0.2.3 后排一条 1 分钟任务，宿主日志确认正常投递；如需验证看门狗，可在官方页暂停某任务过点后观察面板角标仍在、恢复后到点补投（行为与官方语义一致）。

## 审阅 Checkpoint

计划正文到此为止。请先审阅这份计划；确认后可交由普通编码 agent 或人工按计划执行。
