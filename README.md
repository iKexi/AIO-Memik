# MeMik

Privacy, media, automation, temp mail, and proxy tools for Chromium.

## Themes

Click the **sun / moon button** in the header to cycle:

1. **Light** – clean, soft rounded cards
2. **Dark** – deep dark with rounded panels
3. **Glass** – Liquid Glass / iOS-style translucent frosted UI (maximum transparency + blur)

All menus, sheets, cards and windows use rounded rectangles in every theme.

Favourite and Recently used apps now correctly show their icons.

Preference is saved under `uiTheme` in `chrome.storage.local`.

## Load

Load unpacked from `chrome://extensions`.

## Tests

```bash
node tests/smoke-test.js
node tests/full-test.js
node tests/delay-simulation-test.js
node --expose-gc tests/memory-growth-test.js
```
