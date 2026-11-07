# Changelog

## 0.2.0

First real release on npm (the name was reserved by a `0.0.1` placeholder).

- Pending sends for the current session are listed in the panel and can be cancelled (one tap on the ✕ of a row).
- The clock button shows a badge with the number of pending sends.
- The message and the chosen preset are remembered across page reloads.
- On narrow screens (under 480px) the panel renders as a full-width bottom sheet, fixing the clipped popover on phones.
- Double-tapping Schedule now sends exactly one request.
- Fix: scheduling failed with "cannot get property 'remote.schedule' without inject" — the face is now taken from the inject scope instead of the plugin context.
- Compact panel: the title row carries a close button, the five presets fit one row, the send-time summary moved into the action row, and spacing tightened throughout.
- If the Automation tasks feature is disabled in the profile, the clock button renders greyed out with an explanatory tooltip instead of disappearing; it upgrades to the full control as soon as the schedule service is available.
- npm publish metadata: unscoped package, `engines.dsh >= 0.2.2-rc.1`, MIT license, GitHub Actions OIDC release workflow.

## 0.0.1

npm name placeholder only; not a usable release.
