# T46 — Native controls and dark-theme contrast audit

## Root cause

Windows/Chromium native select popups do not consistently inherit a
borderless select's transparent background. The project selector used
theme-light text against a system/native white popup background.

## Fixes

- Explicit `color-scheme` for both application themes, with
  theme-aware `select option`, `option:checked` and `optgroup`
  foreground/background tokens. The closed project selector remains
  transparent inside its header, but the popup is always opaque.
- Themed the legacy `.input` class and unstyled text inputs/textarea;
  excluded checkboxes, radio buttons and non-text browser controls.
  Corrected autofill, file input controls, disabled fields and scrollbars.
- Updated hardcoded warning and error colors in saved-case review,
  import, export, editor, detail and module review dialogs.
- Removed fallback light background colors from run phase status,
  and fixed the Login brand foreground, reconnect retry button and
  active-phase foreground in dark theme.

## Browser verification

Automated Chromium functional test:
`pnpm --filter @localqa/web test:functional-theme`.

- Seven application routes: home, models, members-ops, environments,
  saved-cases, modules, schedules.
- Light and dark themes, 1440/906/390px viewports: 42 cases.
- 168 option/menu contrast checks. Lowest computed foreground/background
  contrast ratio: 8.87:1; every checked option >= 4.5:1.
- All native select color schemes match the application theme.
- Tested legacy inputs, no horizontal page overflow or page JS errors.
- Other web regressions: functional-start, functional-delete,
  functional-report all passed; TypeScript + Vite production build passed.
- Docker Vite serves the new stylesheet, Web/API/Postgres healthy,
  Orchestrator/Worker and detached Compose Watch running.
- The two real DCP projects remain in the database. Browser acceptance
  tests intercept API calls; no paid inference or destructive operations.

Actual OS-drawn popup rendering can vary across browser versions;
the stylesheet sets both CSS option colors and the browser's native
color-scheme so a white-popup / white-text combination is avoided.
