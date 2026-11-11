# Changelog

## 0.2.7

Opening the panel with 指定 (custom) already selected now lands on the smart default immediately.

- The GLM 5h-reset + 2 min prefill used to live only in the 指定 chip's click handler, so when 指定 was the remembered preset the panel opened with the stale mount-time fallback (one hour ahead, possibly already past) — the correct time appeared only after picking another chip and clicking 指定 again. The same fill now runs whenever the panel opens with 指定 selected, and once more when the quota snapshot arrives, so a cold page load converges too.
- A time the user typed by hand always wins: the open-time fill never overwrites a typed instant (and re-selecting the 指定 chip still resets to the default, as before).

## 0.2.6

Four correctness fixes to the pending list and the delivery watchdog. What the watchdog delivers does not change.

- Tasks created in another UI language are adopted. A device now recognises pending sends carrying either built-in title marker (「延时发送：」 or 「Send later: 」), so a send scheduled from an English-language device is listed here, and the watchdog protects it here too.
- A send the catalog already knows as ended or moved no longer lingers in the pending list. A just-created send the catalog has not listed yet stays visible for 30 seconds, down from 5 minutes.
- The redelivery budget counts an attempt only when a run is about to go out. A re-check that finds the task already delivered spends nothing, and an attempt that cannot be recorded in the ledger sends nothing.
- A task the watchdog has retired leaves no entry in the redelivery ledger.

## 0.2.5

The delivery watchdog no longer leaves a redelivered task behind to deliver the same message a second time.

- A run-now the Host admits keeps the task's scheduled occurrence, and the Host delivers it again once its 60 s delivery floor clears. After an admitted run-now the watchdog now deletes the task at once, passing the `updatedAt` the run returned so a task changed in the meantime is left alone; a failed delete is retried every 3 s until that window closes. The task's delivery history goes with it.
- A refused run-now (execution pending, not found) proves nothing was delivered and leaves the task untouched.

## 0.2.4

The panel no longer dismisses itself after a successful schedule. The old auto-close read as "my entry vanished with the card": the confirmation and the fresh pending row were exactly what the user wanted to see, while a non-cancellable 1.6s timer killed the panel even mid-interaction — a stale timer could even close a panel reopened within the window.

- The panel stays open after a successful schedule; closing is always the user's call (✕, outside tap, Escape). The count badge still covers the closed-panel state.
- The confirmation clears only on the events that make it stale: panel close (a reopened panel starts clean), picking a new preset/snippet, or cancelling a pending row — a confirmation never outlives the row it announced.
- The fresh pending row gets a one-shot background highlight (~1.6s fade, theme tokens only) so the new entry is immediately locatable.

## 0.2.3

Silent delivery watchdog: when a scheduled send sits overdue with no delivery receipt (the Host timer loop drops failed one-shots), the plugin nudges the original task through the official run-now channel — up to 3 automatic redeliveries per task, 10 minutes apart, first attempt 5 minutes past due; archived destinations stop the nudging. No new UI; manual run-now stays in the official automation tasks page.

## 0.2.2

Presentation release: house-style gradient icon (clock + departing paper plane), plugin-page meta (annotated title + one-line description, zh/en) in the sibling format, showcase-format README with webp screenshots and dual install paths (official plugin page / dsh-m). No UI or behavior changes.

## 0.2.1

Quota-aware custom time (the prefill), published hours after 0.2.0 which lacked it.

## 0.2.0

First real release on npm (the name was reserved by a `0.0.1` placeholder).

- Pending sends for the current session are listed in the panel and can be cancelled (one tap on the ✕ of a row).
- The clock button shows a badge with the number of pending sends.
- The message and the chosen preset are remembered across page reloads.
- On narrow screens (under 480px) the panel renders as a full-width bottom sheet, fixing the clipped popover on phones.
- Double-tapping Schedule now sends exactly one request.
- Fix: viewport resize no longer closes the panel — on phones the soft keyboard fired a resize when the message field gained focus, which dismissed the card mid-edit; the panel repositions instead.
- Pending sends list their send time as a compact relative label ("10分钟后", fixed-width column, the absolute time on hover).
- Quota-aware custom time: with dsh-quota-watch installed, picking a custom time pre-fills the date and time inputs to the GLM 5-hour reset instant plus two minutes of slack (falls back to one hour ahead without data). Nothing about the quota is displayed anywhere.
- Keyboard-aware positioning: on phones the panel stays above the soft keyboard (visualViewport) instead of hiding behind it.
- Fix: scheduling failed with "cannot get property 'remote.schedule' without inject" — the face is now taken from the inject scope instead of the plugin context.
- Snippet strip beside the message-field label: a fixed "safe resume" chip (bounded continuation) plus the most recent custom prompt — two chips, no horizontal scrolling, long labels truncate in place with the full text on hover. Custom prompts are recorded locally on successful scheduling; the bare default is not recorded.
- Compact panel: the title row carries a close button, the five presets fit one row in a segmented control, the send-time summary moved into the action row, and spacing tightened throughout.
- Submit button and count badge follow a theme-safe color scheme: solid brand blue under the official theme, tonal accent under dsh-skins themes (detected at runtime from the token sheet), with readable text guaranteed on every theme.
- If the Automation tasks feature is disabled in the profile, the clock button renders greyed out with an explanatory tooltip instead of disappearing; it upgrades to the full control as soon as the schedule service is available.
- npm publish metadata: unscoped package, `engines.dsh >= 0.2.2-rc.1`, MIT license, GitHub Actions OIDC release workflow.

## 0.0.1

npm name placeholder only; not a usable release.
