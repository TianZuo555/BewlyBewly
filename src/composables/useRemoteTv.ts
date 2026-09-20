import { useEventListener } from '@vueuse/core'
import type { Ref } from 'vue'

import { getRemoteTvSite } from '~/composables/remoteTvSites'
import { settings } from '~/logic'
import REMOTE_TV_CSS from '~/styles/remote-tv.css?raw'
import { injectCSS } from '~/utils/main'

/**
 * Remote TV — spatial (arrow-key) navigation for remote controls.
 *
 * Designed for remotes mapped to keyboard keys (e.g. Xiaomi remote via a
 * macOS button-mapping app): D-pad emits ArrowUp/Down/Left/Right, OK emits
 * Enter, Back emits Backspace, Menu emits ContextMenu, Power emits Escape.
 *
 * Menu button: single click focuses the search input, double click
 * refreshes the page feed.
 *
 * Site-specifics (card selectors, player, search box, Back pre-steps) live
 * in the per-site adapter — see remoteTvSites.ts. On Bilibili it runs inside
 * the Bewly app (App.vue); on YouTube / YouTube Music it's installed
 * standalone via initRemoteTvStandalone() with no Bewly UI.
 */
export function useRemoteTv(handlePageRefresh?: Ref<(() => void) | undefined>) {
  const resolvedSite = getRemoteTvSite()
  if (!resolvedSite)
    return
  const site = resolvedSite

  const FOCUS_CLASS = 'remote-tv-focused'
  const LAST_HREF_KEY = 'remoteTv:lastHref'

  let focusedCard: HTMLElement | null = null
  let navActive = false

  // Players bind arrow keys (seek/volume) on window/document listeners that
  // were registered before this content script, so we can't stopPropagation
  // them. But they ignore events targeted at form controls — so while element
  // nav is active in player mode, this invisible readonly input holds real
  // DOM focus and swallows the player's key handling.
  let navSink: HTMLInputElement | null = null

  function ensureNavSink(): HTMLInputElement {
    if (navSink?.isConnected)
      return navSink
    navSink = document.createElement('input')
    navSink.readOnly = true
    navSink.setAttribute('style', 'position:fixed;top:0;left:0;width:0;height:0;opacity:0;pointer-events:none')
    document.body.appendChild(navSink)
    return navSink
  }

  // The selection ring is a fixed-position overlay — card-internal ::after
  // approaches get clipped/overpainted by the card's own stacking contexts,
  // so this is the reliable way.
  let ringEl: HTMLElement | null = null
  let ringRaf = 0

  function syncRing() {
    ringRaf = 0
    if (!ringEl || !focusedCard?.isConnected) {
      ringEl?.remove()
      ringEl = null
      return
    }
    const r = focusedCard.getBoundingClientRect()
    const pad = 3
    ringEl.style.left = `${r.left - pad}px`
    ringEl.style.top = `${r.top - pad}px`
    ringEl.style.width = `${r.width + pad * 2}px`
    ringEl.style.height = `${r.height + pad * 2}px`
    ringRaf = requestAnimationFrame(syncRing)
  }

  function showRing() {
    if (!ringEl) {
      ringEl = document.createElement('div')
      ringEl.className = 'remote-tv-ring'
      ringEl.style.setProperty('--remote-tv-accent', site.accent)
      ;(site.ringHost?.() ?? document.body).appendChild(ringEl)
    }
    if (!ringRaf)
      ringRaf = requestAnimationFrame(syncRing)
  }

  function hideRing() {
    if (ringRaf)
      cancelAnimationFrame(ringRaf)
    ringRaf = 0
    ringEl?.remove()
    ringEl = null
    navSink?.blur()
  }

  function getCards(): HTMLElement[] {
    return site.getCards().filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  }

  function isEditableTarget(e: KeyboardEvent): boolean {
    const el = (e.composedPath?.()[0] ?? e.target) as Element | null
    if (!el || !(el instanceof Element))
      return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
  }

  // Dialogs use arrow keys themselves — don't steal keys while one is open.
  function isInsideOverlay(e: KeyboardEvent): boolean {
    return (e.composedPath?.() ?? []).some(
      n => n instanceof Element && (n.getAttribute('role') === 'dialog' || n.classList.contains('dialog')),
    )
  }

  function setFocus(card: HTMLElement | null, { smooth = true } = {}) {
    if (focusedCard && focusedCard !== card)
      focusedCard.classList.remove(FOCUS_CLASS)
    focusedCard = card
    if (!card) {
      hideRing()
      return
    }
    card.classList.add(FOCUS_CLASS)
    card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: smooth ? 'smooth' : 'auto' })
    showRing()
    if (site.isWatchPage())
      ensureNavSink().focus({ preventScroll: true })
  }

  function pickInitial(cards: HTMLElement[]): HTMLElement {
    // Prefer the card closest to the top of the viewport; fall back to first.
    let best = cards[0]
    let bestDist = Infinity
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      const dist = Math.abs(r.top) + Math.abs(r.left) * 0.1
      if (dist < bestDist) {
        bestDist = dist
        best = c
      }
    }
    return best
  }

  function restoreLast(cards: HTMLElement[]): HTMLElement | null {
    try {
      const href = sessionStorage.getItem(LAST_HREF_KEY)
      if (!href)
        return null
      sessionStorage.removeItem(LAST_HREF_KEY)
      return cards.find(c => site.getCardLink(c)?.href === href) ?? null
    }
    catch {
      return null
    }
  }

  function findNearest(from: DOMRect, dir: string, cards: HTMLElement[], exclude?: HTMLElement): HTMLElement | null {
    const fx = from.left + from.width / 2
    const fy = from.top + from.height / 2
    let best: HTMLElement | null = null
    let bestScore = Infinity
    for (const c of cards) {
      if (c === exclude)
        continue
      const r = c.getBoundingClientRect()
      const dx = r.left + r.width / 2 - fx
      const dy = r.top + r.height / 2 - fy
      let primary = 0
      let ortho = 0
      if (dir === 'right' && dx > 4) {
        primary = dx
        ortho = Math.abs(dy)
      }
      else if (dir === 'left' && dx < -4) {
        primary = -dx
        ortho = Math.abs(dy)
      }
      else if (dir === 'down' && dy > 4) {
        primary = dy
        ortho = Math.abs(dx)
      }
      else if (dir === 'up' && dy < -4) {
        primary = -dy
        ortho = Math.abs(dx)
      }
      else {
        continue
      }
      const score = primary + ortho * 3
      if (score < bestScore) {
        bestScore = score
        best = c
      }
    }
    return best
  }

  function moveFocus(dir: 'up' | 'down' | 'left' | 'right', repeat: boolean) {
    const cards = getCards()
    if (!cards.length)
      return
    if (!focusedCard || !focusedCard.isConnected || !cards.includes(focusedCard)) {
      // In player mode, entering element nav starts from the player's rect so
      // e.g. Down lands on whatever is right below the player.
      if (site.isWatchPage() && site.playerSelector) {
        const playerRect = document.querySelector(site.playerSelector)?.getBoundingClientRect()
        const next = playerRect ? findNearest(playerRect, dir, cards) : null
        if (next) {
          setFocus(next, { smooth: false })
          return
        }
      }
      setFocus(restoreLast(cards) ?? pickInitial(cards), { smooth: false })
      return
    }

    const best = findNearest(focusedCard.getBoundingClientRect(), dir, cards, focusedCard)
    if (best) {
      setFocus(best, { smooth: !repeat })
      return
    }
    // Hit the grid edge: on up/down, scroll to trigger the feed's lazy loading.
    if (dir === 'down' || dir === 'up')
      window.scrollBy({ top: (dir === 'down' ? 1 : -1) * window.innerHeight * 0.8, behavior: 'auto' })
  }

  function openFocused() {
    if (!focusedCard)
      return
    // Non-card targets: inputs get real focus, site-specific activate handles
    // the rest (e.g. bilibili comments focusing their reply box).
    if (focusedCard.matches('input, textarea, [contenteditable]')) {
      focusedCard.focus()
      return
    }
    if (site.activate?.(focusedCard))
      return
    const link = site.getCardLink(focusedCard)
    if (link?.href) {
      try {
        sessionStorage.setItem(LAST_HREF_KEY, link.href)
      }
      catch {}
      if (site.openLink)
        site.openLink(link)
      else
        window.location.href = link.href
      return
    }
    focusedCard.click()
  }

  function summonSearchBar() {
    site.searchInput?.()?.focus()
  }

  function refreshPage() {
    if (handlePageRefresh?.value)
      handlePageRefresh.value()
    else
      window.location.reload()
  }

  // Remote Back must never leave the site — when the history stack has no
  // same-site entry left, bottom out at the site's homepage instead.
  function navBack() {
    try {
      const nav = (window as any).navigation
      const entries = nav?.entries?.() as { url: string }[] | undefined
      const idx = nav?.currentEntry?.index ?? -1
      const prevUrl = idx > 0 ? entries?.[idx - 1]?.url : null
      if (prevUrl && site.hostPattern.test(new URL(prevUrl).hostname)) {
        history.back()
        return
      }
    }
    catch {}
    if (!site.isHomePage()) {
      window.location.href = site.homeUrl
      return
    }
    // Back chain bottoms out on the first card.
    const cards = getCards()
    if (cards.length) {
      navActive = true
      setFocus(cards[0], { smooth: false })
    }
  }

  function focusPlayer() {
    const player = site.playerSelector ? document.querySelector<HTMLElement>(site.playerSelector) : null
    player?.focus({ preventScroll: true })
    player?.scrollIntoView({ block: 'nearest' })
  }

  function isRingOnPlayer(): boolean {
    return !!site.playerSelector && !!focusedCard && focusedCard.matches(site.playerSelector)
  }

  // Menu button (ContextMenu key):
  //   single click -> focus the search bar (deferred so a double click can
  //                   pre-empt it)
  //   double click -> refresh the feed
  let menuSuppressSingle = false
  let menuSingleTimer: ReturnType<typeof setTimeout> | undefined
  let lastMenuHandledAt = 0
  const DOUBLE_CLICK_MS = 380

  function onMenuKeyDown(e: KeyboardEvent) {
    lastMenuHandledAt = Date.now()
    e.preventDefault()
    e.stopPropagation()

    // Menu moves attention away from the grid — drop the selection ring.
    navActive = false
    setFocus(null)

    if (e.repeat)
      return
    // Second press while the previous single-click is still pending.
    if (menuSingleTimer) {
      clearTimeout(menuSingleTimer)
      menuSingleTimer = undefined
      menuSuppressSingle = true
      refreshPage()
    }
  }

  function onMenuKeyUp(e: KeyboardEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (menuSuppressSingle) {
      menuSuppressSingle = false
      return
    }
    menuSingleTimer = setTimeout(() => {
      menuSingleTimer = undefined
      summonSearchBar()
    }, DOUBLE_CLICK_MS)
  }

  // The remote's Menu key also synthesizes a contextmenu event — suppress the
  // native menu whenever we just handled a ContextMenu keydown.
  useEventListener(window, 'contextmenu', (e: MouseEvent) => {
    if (Date.now() - lastMenuHandledAt < 600)
      e.preventDefault()
  }, { capture: true })

  useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if (!settings.value.enableRemoteTv)
      return
    if (isInsideOverlay(e))
      return
    const evtTarget = e.composedPath?.()[0] as HTMLInputElement | undefined
    // The navSink holds focus during element nav in player mode — its events
    // belong to the nav state machine, not the editable guard.
    if (isEditableTarget(e) && evtTarget !== navSink) {
      const el = evtTarget
      // Esc in an input just blurs it (a second Esc then goes back).
      if (e.key === 'Escape') {
        el?.blur()
        return
      }
      // In player mode (e.g. the danmaku input), Back always returns focus to
      // the player.
      if (e.key === 'Backspace' && site.isWatchPage()) {
        e.preventDefault()
        e.stopPropagation()
        el?.blur()
        focusPlayer()
        return
      }
      // Back in an input only exits the control — blur it and send a synthetic
      // Escape through so the component's own handler (e.g. the search bar's
      // isFocus=false) closes its UI. It never navigates; the next Back does.
      if (e.key === 'Backspace') {
        e.preventDefault()
        e.stopPropagation()
        if (el && !site.onBackInEditable?.(el)) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          el.blur()
        }
        return
      }
      return
    }

    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key] as 'up' | 'down' | 'left' | 'right' | undefined

    if (dir) {
      // In player mode Left/Right belong to the player (seek) while nothing
      // else is focused or the player itself holds the ring.
      if (site.isWatchPage() && (dir === 'left' || dir === 'right')
        && (!focusedCard || isRingOnPlayer())) {
        return
      }
      if (!getCards().length)
        return // e.g. watch page: leave arrows to the player (seek/volume)
      navActive = true
      e.preventDefault()
      e.stopPropagation()
      moveFocus(dir, e.repeat)
      return
    }

    if (e.key === 'Enter') {
      if (navActive && focusedCard) {
        e.preventDefault()
        e.stopPropagation()
        openFocused()
        return
      }
      // Player mode: OK toggles play/pause.
      const video = document.querySelector('video')
      if (video && (site.isWatchPage() || site.mediaKeysWhenIdle)) {
        e.preventDefault()
        e.stopPropagation()
        video.paused ? video.play() : video.pause()
      }
      return
    }

    if (e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      if (site.closeOverlay?.())
        return
      if (site.onBack?.())
        return
      // In player mode Back returns focus to the player first; a second Back
      // (player mode) navigates away. Ring-on-player counts as player mode.
      if (site.isWatchPage() && (navActive || focusedCard)) {
        if (focusedCard && !isRingOnPlayer()) {
          navActive = false
          setFocus(null)
          focusPlayer()
          return
        }
      }
      navBack()
      return
    }

    if (e.key === 'Escape') {
      // In fullscreen, Esc only exits fullscreen (browser does this anyway).
      if (document.fullscreenElement)
        return
      e.preventDefault()
      e.stopPropagation()
      if (site.closeOverlay?.())
        return
      if (navActive) {
        navActive = false
        setFocus(null)
        if (site.isWatchPage())
          focusPlayer()
      }
      else {
        navBack()
      }
      return
    }

    if (e.key === 'ContextMenu') {
      onMenuKeyDown(e)
    }
  }, { capture: true })

  useEventListener(window, 'keyup', (e: KeyboardEvent) => {
    if (!settings.value.enableRemoteTv)
      return
    if (e.key === 'ContextMenu')
      onMenuKeyUp(e)
  }, { capture: true })
}

/**
 * Standalone install for sites with no Bewly UI (YouTube, YouTube Music) —
 * injects the ring styles and wires up the key handling.
 */
export function initRemoteTvStandalone() {
  injectCSS(REMOTE_TV_CSS)
  useRemoteTv()
}
