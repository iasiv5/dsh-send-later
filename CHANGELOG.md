# Changelog

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
