// =============================================================================
// prompt-viewer — Frontend
// =============================================================================
// Exports setup(ctx) per Spindle's frontend contract.
// Registers a drawer tab that displays captured prompt snapshots.
// =============================================================================

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { PANEL_CSS } from './components/styles'

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

interface PromptSnapshot {
  id: string
  timestamp: number
  messages: LlmMessage[]
  context: Record<string, unknown>
  estimatedTokens: number
  messageId?: string
  messageNumber?: number
  isDryRun?: boolean
  provider?: string
  model?: string
  connectionName?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function genTypeLabel(gt: string): string {
  const labels: Record<string, string> = {
    normal: 'Normal',
    continue: 'Continue',
    regenerate: 'Regen',
    swipe: 'Swipe',
    impersonate: 'Impersonate',
    quiet: 'Quiet',
  }
  return labels[gt] ?? gt
}

function copyToClipboard(text: string): void {
  // Try the modern API first, fall back to textarea method
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  } else {
    fallbackCopy(text)
  }
}

function fallbackCopy(text: string): void {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } catch {
    // Last resort — open in a new window so user can copy manually
    const w = window.open('', '_blank')
    if (w) {
      w.document.write(`<pre>${text.replace(/</g, '&lt;')}</pre>`)
      w.document.close()
    }
  }
  document.body.removeChild(textarea)
}

// ---------------------------------------------------------------------------
// Setup — called by Spindle with the frontend context
// ---------------------------------------------------------------------------
export function setup(ctx: SpindleFrontendContext) {
  // ---- Inject styles ----
  const removeStyle = ctx.dom.addStyle(PANEL_CSS)

  // ---- State ----
  let history: PromptSnapshot[] = []
  let currentSnapshot: PromptSnapshot | null = null
  let viewMode: 'formatted' | 'raw' | 'rendered' = 'formatted'
  let currentChatId: string | null = null
  let showDryRuns = false

  // ---- Register drawer tab ----
  const tab = ctx.ui.registerDrawerTab({
    id: 'prompt-viewer',
    title: 'Prompt Viewer',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v1H3V4zm0 3h14v9a1 1 0 01-1 1H4a1 1 0 01-1-1V7zm3 2v1h8V9H6zm0 3v1h5v-1H6z"/>
    </svg>`,
  })

  const root = tab.root

  // Auto-refresh when the tab is opened
  const unsubActivate = tab.onActivate(() => {
    ctx.sendToBackend({ type: 'get_history' })
  })

  // ---- Build toolbar ----
  const toolbar = document.createElement('div')
  toolbar.className = 'pv-toolbar'

  const select = document.createElement('select')
  select.className = 'pv-history-select'

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = '⟳ Refresh'

  const copyBtn = document.createElement('button')
  copyBtn.textContent = '⎘ Copy'

  const clearBtn = document.createElement('button')
  clearBtn.textContent = '✕ Clear'

  const rawBtn = document.createElement('button')
  rawBtn.textContent = '{ } Raw'

  const renderedBtn = document.createElement('button')
  renderedBtn.textContent = '◉ Rendered'

  const dryRunBtn = document.createElement('button')
  dryRunBtn.textContent = '⚡ Dry Runs'

  const spacer = document.createElement('span')
  spacer.className = 'pv-spacer'

  const status = document.createElement('span')
  status.className = 'pv-status'

  toolbar.append(select, refreshBtn, copyBtn, clearBtn, rawBtn, renderedBtn, dryRunBtn, spacer, status)

  // ---- Message display area ----
  const messagesEl = document.createElement('div')
  messagesEl.className = 'pv-messages'

  root.append(toolbar, messagesEl)

  // ---- Rendering ----
  function renderFormatted(snap: PromptSnapshot): void {
    // Context metadata block
    const ctxBlock = document.createElement('div')
    ctxBlock.className = 'pv-context-block'
    const meta = snap.context as Record<string, unknown>
    const genType = genTypeLabel(String(meta.generationType ?? ''))
    const worldInfoCount = Array.isArray(meta.activatedWorldInfo)
      ? meta.activatedWorldInfo.length
      : 0
    ctxBlock.textContent = [
      `Generation: ${genType}`,
      `Chat: ${meta.chatId ?? '?'}`,
      `Connection: ${meta.connectionId ?? '?'}`,
      `Persona: ${meta.personaId ?? '?'}`,
      worldInfoCount > 0 ? `World Info entries: ${worldInfoCount}` : null,
    ]
      .filter(Boolean)
      .join('\n')
    messagesEl.appendChild(ctxBlock)

    // Messages
    snap.messages.forEach((msg, i) => {
      const wrapper = document.createElement('div')
      wrapper.className = `pv-message pv-role-${msg.role}`

      // Header
      const header = document.createElement('div')
      header.className = 'pv-message-header'

      const label = document.createElement('span')
      const roleText = msg.name ? `${msg.role} (${msg.name})` : msg.role
      label.textContent = `#${i} — ${roleText}`

      const badge = document.createElement('span')
      badge.className = 'pv-token-badge'
      badge.textContent = `~${Math.ceil((msg.content?.length ?? 0) / 4)} tok`

      const toggle = document.createElement('span')
      toggle.className = 'pv-toggle'
      toggle.textContent = '▼'

      header.append(label, badge, toggle)

      // Body
      const body = document.createElement('div')
      body.className = 'pv-message-body'
      body.textContent = msg.content ?? ''

      // Collapse toggle
      let collapsed = false
      header.addEventListener('click', () => {
        collapsed = !collapsed
        body.classList.toggle('pv-collapsed', collapsed)
        toggle.textContent = collapsed ? '▶' : '▼'
      })

      wrapper.append(header, body)
      messagesEl.appendChild(wrapper)
    })
  }

  function renderRaw(snap: PromptSnapshot): void {
    const rawEl = document.createElement('div')
    rawEl.className = 'pv-raw'
    // Show the messages array as clean JSON — this is what goes to the provider
    rawEl.textContent = JSON.stringify(snap.messages, null, 2)
    messagesEl.appendChild(rawEl)
  }

  function renderRendered(snap: PromptSnapshot): void {
    // Concatenate all message content and render HTML tags visually
    const container = document.createElement('div')
    container.className = 'pv-rendered'
    snap.messages.forEach((msg) => {
      if (!msg.content) return
      const block = document.createElement('div')
      block.className = 'pv-rendered-block'
      block.innerHTML = msg.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
      container.appendChild(block)
    })
    messagesEl.appendChild(container)
  }

  function renderSnapshot(snap: PromptSnapshot | null): void {
    messagesEl.textContent = ''

    if (!snap) {
      const empty = document.createElement('div')
      empty.className = 'pv-empty'
      empty.textContent = 'No prompts captured yet.\nSend a message to see the assembled prompt here.'
      messagesEl.appendChild(empty)
      status.textContent = ''
      return
    }

    if (viewMode === 'raw') {
      renderRaw(snap)
    } else if (viewMode === 'rendered') {
      renderRendered(snap)
    } else {
      renderFormatted(snap)
    }

    // Status bar
    const dryLabel = snap.isDryRun ? '[DRY RUN] ' : ''
    const msgLabel = snap.messageNumber ? `Msg #${snap.messageNumber} · ` : ''
    const apiLabel = snap.model
      ? `${snap.provider ? snap.provider + ' / ' : ''}${snap.model} · `
      : ''
    status.textContent = `${dryLabel}${msgLabel}${apiLabel}${snap.messages.length} messages · ~${snap.estimatedTokens} tok · ${formatTime(snap.timestamp)}`
  }

  function getFilteredHistory(): PromptSnapshot[] {
    if (showDryRuns) return history
    return history.filter((s) => !s.isDryRun)
  }

  function populateSelect(): void {
    select.textContent = ''
    const filtered = getFilteredHistory()
    if (filtered.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '(no history)'
      select.appendChild(opt)
      return
    }
    filtered.forEach((snap, i) => {
      const opt = document.createElement('option')
      opt.value = snap.id
      const prefix = i === 0 ? '● ' : ''
      const dryTag = snap.isDryRun ? '[DRY] ' : ''
      const gt = genTypeLabel(String((snap.context as any)?.generationType ?? ''))
      const msgLabel = snap.messageNumber ? `#${snap.messageNumber}` : ''
      opt.textContent = `${prefix}${dryTag}${msgLabel ? msgLabel + ' · ' : ''}${formatTime(snap.timestamp)} · ${gt} · ${snap.messages.length} msgs`
      select.appendChild(opt)
    })
  }

  // ---- Event handlers ----
  select.addEventListener('change', () => {
    const snap = history.find((s) => s.id === select.value) ?? null
    currentSnapshot = snap
    renderSnapshot(snap)
  })

  refreshBtn.addEventListener('click', () => {
    ctx.sendToBackend({ type: 'get_history' })
  })

  copyBtn.addEventListener('click', () => {
    if (!currentSnapshot) return
    let text: string
    if (viewMode === 'raw') {
      text = JSON.stringify(currentSnapshot.messages, null, 2)
    } else if (viewMode === 'rendered') {
      text = currentSnapshot.messages
        .map((m) => m.content)
        .filter(Boolean)
        .join('\n\n')
    } else {
      text = currentSnapshot.messages
        .map(
          (m, i) =>
            `--- [${i}] ${m.role}${m.name ? ` (${m.name})` : ''} ---\n${m.content}`
        )
        .join('\n\n')
    }
    copyToClipboard(text)
    copyBtn.textContent = '✓ Copied'
    setTimeout(() => { copyBtn.textContent = '⎘ Copy' }, 1500)
  })

  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all captured prompts for this chat? This cannot be undone.')) return
    ctx.sendToBackend({ type: 'clear_history' })
  })

  rawBtn.addEventListener('click', () => {
    viewMode = viewMode === 'raw' ? 'formatted' : 'raw'
    rawBtn.classList.toggle('pv-active', viewMode === 'raw')
    rawBtn.textContent = viewMode === 'raw' ? '{ } Raw ✓' : '{ } Raw'
    renderedBtn.classList.remove('pv-active')
    renderedBtn.textContent = '◉ Rendered'
    renderSnapshot(currentSnapshot)
  })

  renderedBtn.addEventListener('click', () => {
    viewMode = viewMode === 'rendered' ? 'formatted' : 'rendered'
    renderedBtn.classList.toggle('pv-active', viewMode === 'rendered')
    renderedBtn.textContent = viewMode === 'rendered' ? '◉ Rendered ✓' : '◉ Rendered'
    rawBtn.classList.remove('pv-active')
    rawBtn.textContent = '{ } Raw'
    renderSnapshot(currentSnapshot)
  })

  dryRunBtn.addEventListener('click', () => {
    showDryRuns = !showDryRuns
    dryRunBtn.classList.toggle('pv-active', showDryRuns)
    dryRunBtn.textContent = showDryRuns ? '⚡ Dry Runs ✓' : '⚡ Dry Runs'
    populateSelect()
    // If current snapshot is a dry-run and we just hid them, show the latest visible one
    const filtered = getFilteredHistory()
    if (currentSnapshot?.isDryRun && !showDryRuns) {
      currentSnapshot = filtered[0] ?? null
      if (currentSnapshot) select.value = currentSnapshot.id
      renderSnapshot(currentSnapshot)
    }
    tab.setBadge(filtered.length > 0 ? String(filtered.length) : '')
  })

  // ---- Backend message listener ----
  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    switch (payload.type) {
      case 'prompt_captured': {
        // Only show prompts for the current chat
        const snapChatId = (payload.snapshot?.context as any)?.chatId
        if (snapChatId && currentChatId && snapChatId !== currentChatId) break

        // Track current chat from first capture if not set yet
        if (!currentChatId && snapChatId) currentChatId = snapChatId

        history.unshift(payload.snapshot)
        if (history.length > 50) history.pop()
        populateSelect()

        const filtered = getFilteredHistory()
        // Auto-display if it's visible (not a hidden dry-run)
        const isVisible = !payload.snapshot.isDryRun || showDryRuns
        if (isVisible) {
          currentSnapshot = payload.snapshot
          select.value = payload.snapshot.id
          renderSnapshot(payload.snapshot)
        }
        tab.setBadge(filtered.length > 0 ? String(filtered.length) : '')
        break
      }

      case 'prompt_history': {
        history = payload.snapshots ?? []
        populateSelect()
        const filtered = getFilteredHistory()
        if (filtered.length > 0) {
          currentSnapshot = filtered[0]
          select.value = filtered[0].id
          renderSnapshot(filtered[0])
        } else {
          currentSnapshot = null
          renderSnapshot(null)
        }
        tab.setBadge(filtered.length > 0 ? String(filtered.length) : '')
        break
      }

      case 'prompt_data': {
        currentSnapshot = payload.snapshot ?? null
        renderSnapshot(currentSnapshot)
        break
      }

      case 'history_cleared': {
        history = []
        currentSnapshot = null
        populateSelect()
        renderSnapshot(null)
        tab.setBadge('')
        break
      }

      case 'chat_changed': {
        currentChatId = payload.chatId
        history = payload.snapshots ?? []
        populateSelect()
        const filtered = getFilteredHistory()
        if (filtered.length > 0) {
          currentSnapshot = filtered[0]
          select.value = filtered[0].id
          renderSnapshot(filtered[0])
        } else {
          currentSnapshot = null
          renderSnapshot(null)
        }
        tab.setBadge(filtered.length > 0 ? String(filtered.length) : '')
        break
      }

      case 'snapshot_updated': {
        const updated = payload.snapshot as PromptSnapshot
        if (updated) {
          const idx = history.findIndex((s) => s.id === updated.id)
          if (idx !== -1) {
            history[idx] = updated
            populateSelect()
            if (currentSnapshot?.id === updated.id) {
              currentSnapshot = updated
              select.value = updated.id
              renderSnapshot(updated)
            }
          }
        }
        break
      }
    }
  })

  // ---- Listen for chat switches on the frontend side ----
  const unsubChatChanged = ctx.events.on('CHAT_CHANGED', (payload: any) => {
    const chatId = payload.chatId ?? payload.chat?.id
    if (chatId) {
      currentChatId = chatId
      ctx.sendToBackend({ type: 'set_active_chat', chatId })
    }
  })

  // ---- Initial data fetch ----
  ctx.sendToBackend({ type: 'get_history' })

  // ---- Cleanup ----
  return () => {
    unsubBackend()
    unsubChatChanged()
    unsubActivate()
    removeStyle()
    tab.destroy()
    ctx.dom.cleanup()
  }
}
