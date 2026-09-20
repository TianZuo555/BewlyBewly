# Remote TV

Remote TV adds spatial (arrow-key) navigation so the extension can be driven
with a TV remote instead of a mouse. It is designed for remotes whose buttons
are mapped to keyboard keys (e.g. a Xiaomi remote through a macOS
button-mapping app), but any keyboard works.

Supported sites:

| Site          | Mode                                             |
| ------------- | ------------------------------------------------ |
| Bilibili      | Inside the Bewly UI (and stock Bilibili pages)   |
| YouTube       | Standalone — no Bewly UI, navigation only        |
| YouTube Music | Standalone — no Bewly UI, navigation only        |

Toggle it under **Settings → General → Remote TV**
(`settings.enableRemoteTv`, default: on).

## Remote button → key mapping

| Remote button | Key emitted | Action                                                  |
| ------------- | ----------- | ------------------------------------------------------- |
| D-pad         | Arrow keys  | Move the selection ring between cards/items             |
| OK            | Enter       | Open the focused card; play/pause in player mode        |
| Back          | Backspace   | Close overlays → exit inputs → return to player → go back |
| Menu          | ContextMenu | Single click: focus search. Double click: refresh feed  |
| Power         | Escape      | Exit nav / close overlays / go back                     |

## Behavior

### Grid navigation

- The first arrow press highlights the card nearest the top of the viewport
  (or the card you were on before opening a page — the last opened `href` is
  remembered in `sessionStorage` and restored on Back).
- Movement is geometric: the nearest neighbor in the pressed direction wins,
  weighted `primary + ortho * 3` so mostly-aligned cards are preferred.
- Reaching the bottom/top edge scrolls the page to trigger lazy loading.

### Player mode (watch pages)

On a watch page the player owns the remote until you navigate into the grid:

- **Left/Right** seek, **OK** toggles play/pause while nothing is focused.
- **Up/Down** enters element navigation starting from the player's position.
- Extra targets become navigable (player, danmaku input/send, toolbar, uploader
  info, comments on Bilibili; player, like/dislike, subscribe, comment box,
  comments on YouTube; player-bar controls on YouTube Music).
- **Back** first returns focus to the player; a second Back navigates away.

YouTube Music is always "player mode" while something is playing (the player
bar lives on every page); when playback is paused or idle it behaves like a
plain grid page.

### Back never leaves the site

Back walks the history stack only while the previous entry is on the same site
(checked via the Navigation API). Once it runs out, Back bottoms out at the
site's homepage, and on the homepage it selects the first card.

### Overlays and inputs

- Open dialogs (`role="dialog"`, YouTube's `tp-yt-paper-dialog`s, the Bewly
  video drawer) eat Back/Esc first and get closed instead of navigating.
- Back inside an input never navigates — it exits the control (and, in player
  mode, returns focus to the player). The next Back then works normally.

## Architecture

```
src/composables/remoteTvSites.ts   RemoteTvSite interface + per-site adapters
src/composables/useRemoteTv.ts     Site-agnostic engine + initRemoteTvStandalone()
src/styles/remote-tv.css           Selection-ring styles (accent via --remote-tv-accent)
src/contentScripts/index.ts        Dispatches: Bewly bootstrap on Bilibili,
                                   Remote TV standalone on YouTube/YT Music
src/manifest.ts                    Adds the YouTube content_scripts entry
```

- **Engine** (`useRemoteTv`) resolves its site via
  `getRemoteTvSite(location.hostname)` and drives a state machine over a
  `keydown`/`keyup` pair (capture phase). The selection ring is a
  fixed-position overlay re-parented into the Bewly shadow root on Bilibili
  and `document.body` elsewhere; a `requestAnimationFrame` loop keeps it glued
  to the focused card.
- **navSink**: players bind their own arrow-key handlers before this script
  runs, so while element nav is active in player mode an invisible readonly
  `<input>` holds DOM focus — players ignore keys targeted at form controls.
- **Adapters** (`remoteTvSites.ts`) declare, per site: card selectors, watch
  targets, player selector, link extraction, link-opening strategy (Bilibili
  honors `videoCardLinkOpenMode` including drawer mode; YouTube/YT Music click
  the link so SPA navigation stays in-place), search input for Menu, Back
  pre-steps (Bilibili's drawer/search-bar/search-results exits, YouTube's
  popup dismissal), homepage URL, and the never-leave-site host pattern.
- **Bilibili**: installed from `App.vue` (`useRemoteTv(handlePageRefresh)`),
  so Menu double-click refreshes the feed instead of reloading.
- **YouTube / YouTube Music**: `initRemoteTvStandalone()` injects
  `remote-tv.css` and installs the engine — no Bewly app, no Bewly
  stylesheet. The manifest entry has no `css` and no `all_frames`, so the
  script only runs in top frames.

### Adding a new site

1. Add a `RemoteTvSite` adapter in `remoteTvSites.ts` and register it in
   `SITES` (before `youtube` if the hostname overlaps).
2. Add the host to the YouTube `content_scripts` entry (or a new entry) in
   `src/manifest.ts`.

## Caveats

- YouTube/YT Music selectors (`ytd-*`, `ytmusic-*` renderers) are stable
  element names but Google restructures their internals occasionally — if the
  ring stops landing, check `cardSelectors`/`watchTargets` in the adapter.
- `Backspace`/`ContextMenu` as Back/Menu assumes a remote mapping that emits
  those keys; remap the remote app, not the code, if yours differs.
