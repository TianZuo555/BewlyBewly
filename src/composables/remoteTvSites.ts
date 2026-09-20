import { settings } from '~/logic'
import { isHomePage } from '~/utils/main'

/**
 * Per-site configuration for Remote TV (see useRemoteTv).
 *
 * The engine is site-agnostic — everything it needs to know about a page
 * (which elements are navigable, where the player lives, how links open,
 * site-specific Back pre-steps) comes from the adapter matching
 * `location.hostname`.
 */
export interface RemoteTvSite {
  name: 'bilibili' | 'youtube' | 'youtube-music'
  /** Tested against `location.hostname`. */
  hosts: RegExp
  /** Back never leaves the site — the previous history entry's hostname must match this. */
  hostPattern: RegExp
  /** Where Back bottoms out when no same-site history entry is left. */
  homeUrl: string
  isHomePage: () => boolean
  /**
   * "Player mode": the page has a player that owns Left/Right (seek) and
   * unfocused OK (play/pause). Element nav is still entered via Up/Down.
   */
  isWatchPage: () => boolean
  /** The player element; the ring resting on it counts as player mode. */
  playerSelector?: string
  /** OK toggles play/pause even when this isn't a watch page. */
  mediaKeysWhenIdle?: boolean
  /** Selection-ring accent color (CSS color value). */
  accent: string
  /** All D-pad navigable elements (cards + watch-page extras). */
  getCards: () => HTMLElement[]
  /** Actionable link inside a card. */
  getCardLink: (card: HTMLElement) => HTMLAnchorElement | null
  /** How a card link opens — default is same-tab navigation. */
  openLink?: (link: HTMLAnchorElement) => void
  /** OK on a non-card element; return true when handled. */
  activate?: (el: HTMLElement) => boolean
  /** Element the Menu single-click focuses. */
  searchInput?: () => HTMLElement | null
  /** Where the ring overlay is appended — default `document.body`. */
  ringHost?: () => ShadowRoot | HTMLElement
  /** An open overlay/dialog that should eat Back and Esc; return true when handled. */
  closeOverlay?: () => boolean
  /** Site-specific Back pre-steps (after closeOverlay); return true when handled. */
  onBack?: () => boolean
  /** Back inside an editable; return true when handled. */
  onBackInEditable?: (el: HTMLElement) => boolean
}

function exitEditable(el: HTMLElement) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  el.blur()
}

// YouTube & YouTube Music share the tp-yt-paper-dialog/iron-dropdown popup
// system — a visible one eats Back/Esc and gets dismissed with a synthetic Esc.
function closeYtPopup(): boolean {
  const open = Array.from(document.querySelectorAll<HTMLElement>(
    'ytd-popup-container tp-yt-paper-dialog, ytmusic-popup-container tp-yt-paper-dialog, tp-yt-iron-dropdown',
  )).some(d => d.getBoundingClientRect().height > 0)
  if (!open)
    return false
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
}

function createBilibiliSite(): RemoteTvSite {
  // On bilibili search-results pages the first Back "exits the search bar"
  // (unfocuses the visible query input) instead of navigating — a second
  // Back then goes back normally.
  const isSearchResultsPage = /^search\./.test(location.hostname)
  let searchPageExited = false

  const isWatchPage = () => !!document.querySelector('.bpx-player-container')

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

  return {
    name: 'bilibili',
    hosts: /(?:^|\.)(?:bilibili\.com|hdslb\.com)$/i,
    hostPattern: /(?:^|\.)bilibili\.com$/i,
    homeUrl: 'https://www.bilibili.com/',
    isHomePage: () => isHomePage(),
    isWatchPage,
    playerSelector: '.bpx-player-container, #bilibili-player',
    accent: 'var(--bew-theme-color, #00a1d6)',

    getCards() {
      const cards: HTMLElement[] = []
      const bewly = document.querySelector('#bewly')
      if (bewly?.shadowRoot)
        cards.push(...Array.from(bewly.shadowRoot.querySelectorAll<HTMLElement>('.video-card')))
      cards.push(...Array.from(document.querySelectorAll<HTMLElement>('.bili-video-card, .video-page-card-small')))
      if (isWatchPage()) {
        // Extra focusable targets on video pages, in addition to the rec
        // cards. The player itself is included so Up can move focus onto it.
        const watchTargets = [
          '.bpx-player-container',
          '.bpx-player-dm-input',
          '.bpx-player-dm-btn-send',
          '.toolbar-left-item-wrap',
          '.up-info-container',
          'bili-comments',
        ]
        for (const sel of watchTargets)
          cards.push(...Array.from(document.querySelectorAll<HTMLElement>(sel)))
      }
      return cards
    },

    getCardLink: card => card.querySelector<HTMLAnchorElement>('a[href*="/video/"], a[href*="/bangumi/"], a[href*="/live/"]')
    ?? card.querySelector<HTMLAnchorElement>('a[href]'),

    openLink(link) {
      if (settings.value.videoCardLinkOpenMode === 'drawer') {
        // Drawer opens in-page and closes via Esc — keep that path.
        link.click()
      }
      else {
        // Remote UX: always navigate in the current tab so Back can return.
        window.location.href = link.href
      }
    },

    activate(el) {
      // The comments web component focuses its inner reply box.
      if (el.tagName === 'BILI-COMMENTS') {
        const reply = el.shadowRoot
          ?.querySelector<HTMLElement>('[contenteditable="true"], textarea, .reply-box textarea, .reply-box')
        if (reply)
          reply.focus()
        return true
      }
      return false
    },

    searchInput: () => document.querySelector('#bewly')?.shadowRoot
      ?.querySelector<HTMLInputElement>('.search-bar input') ?? null,

    // The ring lives in the #bewly shadow root so the app can't overpaint it.
    ringHost: () => document.querySelector('#bewly')?.shadowRoot ?? document.body,

    closeOverlay: closeDrawerIfOpen,

    onBack() {
      // The top-bar search box can keep shadow-DOM focus after landing on the
      // results page — the first Back exits it instead of navigating.
      const bewly = document.querySelector('#bewly')?.shadowRoot
      const searchInput = bewly?.querySelector<HTMLElement>('.search-bar input')
      if (searchInput && bewly?.activeElement === searchInput) {
        exitEditable(searchInput)
        return true
      }
      // Search-results page: first Back exits the search bar (the stock
      // bilibili input keeps showing the query), then Back navigates.
      if (isSearchResultsPage && !searchPageExited) {
        searchPageExited = true
        const si = document.querySelector<HTMLElement>('.search-input-el')
        if (si)
          exitEditable(si)
        return true
      }
      return false
    },

    onBackInEditable(el) {
      searchPageExited = true
      exitEditable(el)
      return true
    },
  }
}

const YT_CARD_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-playlist-panel-video-renderer',
  'ytd-movie-renderer',
  'ytd-channel-renderer',
  'ytd-playlist-renderer',
  'ytd-radio-renderer',
  'ytd-reel-item-renderer',
  'ytd-reel-video-renderer',
]

// Extra focusable targets on /watch, in addition to the sidebar rec cards.
const YT_WATCH_TARGETS = [
  '#movie_player',
  'like-button-view-model button',
  'dislike-button-view-model button',
  'ytd-subscribe-button-renderer',
  'ytd-comment-simplebox-renderer',
  'ytd-comments',
]

const youtube: RemoteTvSite = {
  name: 'youtube',
  hosts: /(?:^|\.)youtube\.com$/i,
  hostPattern: /(?:^|\.)youtube\.com$/i,
  homeUrl: 'https://www.youtube.com/',
  isHomePage: () => location.pathname === '/',
  isWatchPage: () => location.pathname === '/watch' || location.pathname.startsWith('/shorts/'),
  playerSelector: '#movie_player, ytd-player',
  accent: '#ff0000',

  getCards() {
    const cards: HTMLElement[] = []
    for (const sel of YT_CARD_SELECTORS)
      cards.push(...Array.from(document.querySelectorAll<HTMLElement>(sel)))
    if (this.isWatchPage()) {
      for (const sel of YT_WATCH_TARGETS)
        cards.push(...Array.from(document.querySelectorAll<HTMLElement>(sel)))
    }
    return cards
  },

  getCardLink: card => card.querySelector<HTMLAnchorElement>('a#thumbnail[href], a#video-title-link[href], a#video-title[href]')
  ?? card.querySelector<HTMLAnchorElement>('a[href*="/watch"], a[href*="/shorts"], a[href*="/playlist"], a[href*="/channel/"], a[href*="/@"]')
  ?? card.querySelector<HTMLAnchorElement>('a[href]'),

  // YouTube is an SPA — a real click takes the yt-navigate path and avoids a
  // full reload, while still landing Back on the previous page.
  openLink: link => link.click(),

  searchInput: () => document.querySelector<HTMLInputElement>('ytd-searchbox input#search, input#search'),

  closeOverlay: closeYtPopup,
}

const YTM_CARD_SELECTORS = [
  'ytmusic-two-row-item-renderer',
  'ytmusic-responsive-list-item-renderer',
  'ytmusic-player-queue-item',
  'ytmusic-card-shelf-renderer',
]

// Player-bar controls, reachable while music is playing.
const YTM_WATCH_TARGETS = [
  'ytmusic-player-bar',
  'ytmusic-player-bar tp-yt-paper-icon-button',
  'ytmusic-player-bar ytmusic-like-button-renderer',
  'ytmusic-player-bar .content-info-wrapper',
]

const youtubeMusic: RemoteTvSite = {
  name: 'youtube-music',
  hosts: /^music\.youtube\.com$/i,
  hostPattern: /(?:^|\.)youtube\.com$/i,
  homeUrl: 'https://music.youtube.com/',
  isHomePage: () => location.pathname === '/',
  // Player mode only while something is playing — Left/Right seek and OK
  // pauses; when paused or idle the D-pad drives plain grid navigation.
  isWatchPage: () => {
    const video = document.querySelector('video')
    return !!video && !video.paused
  },
  playerSelector: 'ytmusic-player-bar',
  mediaKeysWhenIdle: true,
  accent: '#ff0000',

  getCards() {
    const cards: HTMLElement[] = []
    for (const sel of YTM_CARD_SELECTORS)
      cards.push(...Array.from(document.querySelectorAll<HTMLElement>(sel)))
    if (this.isWatchPage()) {
      for (const sel of YTM_WATCH_TARGETS)
        cards.push(...Array.from(document.querySelectorAll<HTMLElement>(sel)))
    }
    return cards
  },

  getCardLink: card => card.querySelector<HTMLAnchorElement>('a[href*="/watch"], a[href*="playlist"], a[href*="browse/"], a[href*="/channel/"]')
  ?? card.querySelector<HTMLAnchorElement>('a[href]'),

  openLink: link => link.click(),

  searchInput: () => document.querySelector<HTMLInputElement>('ytmusic-search-box input'),

  closeOverlay: closeYtPopup,
}

// Order matters — youtube's host pattern also matches music.youtube.com, so
// the more specific adapter must be checked first.
const SITES: RemoteTvSite[] = [youtubeMusic, youtube, createBilibiliSite()]

export function getRemoteTvSite(hostname: string = location.hostname): RemoteTvSite | undefined {
  return SITES.find(site => site.hosts.test(hostname))
}
