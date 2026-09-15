import { useEventListener } from '@vueuse/core'
import type { Ref } from 'vue'

import { settings } from '~/logic'

/**
 * Spatial (arrow-key) navigation for remote controls.
 *
 * Designed for remotes mapped to keyboard keys (e.g. Xiaomi remote via a
 * macOS button-mapping app): D-pad emits ArrowUp/Down/Left/Right, OK emits
 * Enter, Back emits Backspace, Menu emits ContextMenu, Power emits Escape.
 *
 * Menu button: single click focuses the top-bar search input, double click
 * refreshes the page feed.
 *
 * Works on `.video-card` inside the #bewly shadow root and falls back to
 * `.bili-video-card` on stock Bilibili pages.
 */
export function useRemoteNav(handlePageRefresh?: Ref<(() => void) | undefined>) {
  const FOCUS_CLASS = 'remote-nav-focused'
  const LAST_HREF_KEY = 'remoteNav:lastHref'

  let focusedCard: HTMLElement | null = null
  let navActive = false

  // The selection ring is a fixed-position overlay appended to the shadow
  // root — card-internal ::after approaches get clipped/overpainted by the
  // card's own stacking contexts, so this is the reliable way.
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
      ringEl.className = 'remote-nav-ring'
      const host = document.querySelector('#bewly')?.shadowRoot ?? document.body
      host.appendChild(ringEl)
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
  }

  function getCards(): HTMLElement[] {
    const cards: HTMLElement[] = []
    const bewly = document.querySelector('#bewly')
    if (bewly?.shadowRoot)
      cards.push(...Array.from(bewly.shadowRoot.querySelectorAll<HTMLElement>('.video-card')))
    cards.push(...Array.from(document.querySelectorAll<HTMLElement>('.bili-video-card')))
    return cards.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && el.querySelector('a[href]')
    })
  }

  function getCardLink(card: HTMLElement): HTMLAnchorElement | null {
    return card.querySelector<HTMLAnchorElement>('a[href*="/video/"], a[href*="/bangumi/"], a[href*="/live/"]')
      ?? card.querySelector<HTMLAnchorElement>('a[href]')
  }

  function isEditableTarget(e: KeyboardEvent): boolean {
    const el = (e.composedPath?.()[0] ?? e.target) as Element | null
    if (!el || !(el instanceof Element))
      return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
  }

  // BewlyBewly dialogs (e.g. the dislike dialog) use arrow keys themselves,
  // don't steal keys while one is open.
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
      return cards.find(c => getCardLink(c)?.href === href) ?? null
    }
    catch {
      return null
    }
  }

  function moveFocus(dir: 'up' | 'down' | 'left' | 'right', repeat: boolean) {
    const cards = getCards()
    if (!cards.length)
      return
    if (!focusedCard || !focusedCard.isConnected || !cards.includes(focusedCard)) {
      setFocus(restoreLast(cards) ?? pickInitial(cards), { smooth: false })
      return
    }

    const fr = focusedCard.getBoundingClientRect()
    const fx = fr.left + fr.width / 2
    const fy = fr.top + fr.height / 2
    let best: HTMLElement | null = null
    let bestScore = Infinity
    for (const c of cards) {
      if (c === focusedCard)
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
    const link = getCardLink(focusedCard)
    if (!link?.href)
      return
    try {
      sessionStorage.setItem(LAST_HREF_KEY, link.href)
    }
    catch {}
    if (settings.value.videoCardLinkOpenMode === 'drawer') {
      // Drawer opens in-page and closes via Esc — keep that path.
      link.click()
    }
    else {
      // Remote UX: always navigate in the current tab so Back can return.
      window.location.href = link.href
    }
  }

  function summonSearchBar() {
    const input = document.querySelector('#bewly')?.shadowRoot
      ?.querySelector<HTMLInputElement>('.search-bar input')
    input?.focus()
  }

  function refreshPage() {
    if (handlePageRefresh?.value)
      handlePageRefresh.value()
    else
      window.location.reload()
  }

  // If an iframe drawer is open, click its close button. Returns whether a
  // drawer was open (so callers can skip history.back()).
  function closeDrawerIfOpen(): boolean {
    const sr = document.querySelector('#bewly')?.shadowRoot
    if (!sr)
      return false
    const iframe = sr.querySelector('iframe')
    if (!iframe || iframe.getBoundingClientRect().height < window.innerHeight * 0.5)
      return false
    const btn = Array.from(sr.querySelectorAll<HTMLElement>('[class*="close-line"]'))
      .map(i => i.closest('button'))
      .find(b => b && b.getBoundingClientRect().width > 0)
    if (!btn)
      return false
    btn.click()
    return true
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
    if (!settings.value.enableRemoteNavigation)
      return
    if (isInsideOverlay(e))
      return
    if (isEditableTarget(e)) {
      const el = e.composedPath?.()[0] as HTMLInputElement | undefined
      // Esc in an input just blurs it (a second Esc then goes back).
      if (e.key === 'Escape') {
        el?.blur()
        return
      }
      // Back on an empty input behaves as navigate-back; with text, let it edit.
      if (e.key === 'Backspace') {
        if (el && 'value' in el && el.value.trim() !== '')
          return
        e.preventDefault()
        e.stopPropagation()
        el?.blur()
        if (!closeDrawerIfOpen())
          history.back()
      }
      return
    }

    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key] as 'up' | 'down' | 'left' | 'right' | undefined

    if (dir) {
      if (!getCards().length)
        return // e.g. video page: leave arrows to the player (seek/volume)
      navActive = true
      e.preventDefault()
      e.stopPropagation()
      moveFocus(dir, e.repeat)
      return
    }

    if (e.key === 'Enter') {
      if (!navActive || !focusedCard)
        return
      e.preventDefault()
      e.stopPropagation()
      openFocused()
      return
    }

    if (e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      if (!closeDrawerIfOpen())
        history.back()
      return
    }

    if (e.key === 'Escape') {
      // In fullscreen, Esc only exits fullscreen (browser does this anyway).
      if (document.fullscreenElement)
        return
      e.preventDefault()
      e.stopPropagation()
      if (closeDrawerIfOpen())
        return
      if (navActive) {
        navActive = false
        setFocus(null)
      }
      else {
        history.back()
      }
      return
    }

    if (e.key === 'ContextMenu') {
      onMenuKeyDown(e)
    }
  }, { capture: true })

  useEventListener(window, 'keyup', (e: KeyboardEvent) => {
    if (!settings.value.enableRemoteNavigation)
      return
    if (e.key === 'ContextMenu')
      onMenuKeyUp(e)
  }, { capture: true })
}
