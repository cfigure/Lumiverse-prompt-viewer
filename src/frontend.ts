// =============================================================================
// prompt-viewer — Frontend
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
  generationId?: string
  messageId?: string
  messageNumber?: number
  isDryRun?: boolean
  model?: string
  regenFeedback?: string
  regenFeedbackPosition?: 'system' | 'user'
  isSwipe?: boolean
  swipeIndex?: number
  wasAborted?: boolean
  approximateTokens?: boolean
  tokenizer?: string
}

interface Settings {
  defaultViewMode: 'formatted' | 'raw' | 'rendered'
  showDryRunsByDefault: boolean
  dryRunMode: 'only' | 'alongside'
  maxHistoryPerChat: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
  maxHistoryPerChat: 50,
}

const GATED_PERMISSIONS = ['interceptor', 'generation', 'chat_mutation', 'chats']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function msgText(content: string): string {
  return content ?? ''
}

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
    const w = window.open('', '_blank')
    if (w) {
      w.document.write(`<pre>${text.replace(/</g, '&lt;')}</pre>`)
      w.document.close()
    }
  }
  document.body.removeChild(textarea)
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------
function createSettingsUI(
  currentSettings: Settings,
  onSave: (s: Settings) => void,
): { root: HTMLElement; update: (s: Settings) => void } {
  const root = document.createElement('div')
  root.className = 'pv-settings'

  const title = document.createElement('div')
  title.className = 'pv-settings-title'
  title.textContent = 'Prompt Viewer'
  root.appendChild(title)

  const card = document.createElement('div')
  card.className = 'pv-settings-card'

  function addRow(label: string, input: HTMLElement): void {
    const row = document.createElement('div')
    row.className = 'pv-settings-row'
    const lbl = document.createElement('label')
    lbl.className = 'pv-settings-label'
    lbl.textContent = label
    row.append(lbl, input)
    card.appendChild(row)
  }

  // Default view mode
  const viewSelect = document.createElement('select')
  viewSelect.className = 'pv-settings-input'
  for (const mode of ['formatted', 'raw', 'rendered'] as const) {
    const opt = document.createElement('option')
    opt.value = mode
    opt.textContent = mode.charAt(0).toUpperCase() + mode.slice(1)
    if (mode === currentSettings.defaultViewMode) opt.selected = true
    viewSelect.appendChild(opt)
  }
  addRow('Default view mode', viewSelect)

  // Show dry runs
  const dryCheck = document.createElement('input')
  dryCheck.type = 'checkbox'
  dryCheck.checked = currentSettings.showDryRunsByDefault
  addRow('Show dry runs by default', dryCheck)

  // Dry run display mode
  const dryModeSelect = document.createElement('select')
  dryModeSelect.className = 'pv-settings-input'
  for (const [value, label] of [['only', 'Dry runs only'], ['alongside', 'Alongside normal']] as const) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = label
    if (value === currentSettings.dryRunMode) opt.selected = true
    dryModeSelect.appendChild(opt)
  }
  addRow('Dry run display', dryModeSelect)

  // Max history
  const maxInput = document.createElement('input')
  maxInput.className = 'pv-settings-input'
  maxInput.type = 'number'
  maxInput.min = '5'
  maxInput.max = '500'
  maxInput.value = String(currentSettings.maxHistoryPerChat)
  addRow('Max prompts per chat', maxInput)

  // Warning about max history
  const note = document.createElement('div')
  note.className = 'pv-settings-note'
  note.textContent = 'Higher values use more memory. Prompt data is not persisted — history clears on restart. Values above 100 may cause performance issues with large prompts.'
  card.appendChild(note)

  // Save
  const saveBtn = document.createElement('button')
  saveBtn.className = 'pv-settings-save'
  saveBtn.textContent = 'Save Settings'
  saveBtn.addEventListener('click', () => {
    onSave({
      defaultViewMode: viewSelect.value as Settings['defaultViewMode'],
      showDryRunsByDefault: dryCheck.checked,
      dryRunMode: dryModeSelect.value as Settings['dryRunMode'],
      maxHistoryPerChat: Math.min(500, Math.max(5, parseInt(maxInput.value) || 50)),
    })
    saveBtn.textContent = '✓ Saved'
    setTimeout(() => { saveBtn.textContent = 'Save Settings' }, 1500)
  })
  card.appendChild(saveBtn)

  root.appendChild(card)

  function update(s: Settings): void {
    viewSelect.value = s.defaultViewMode
    dryCheck.checked = s.showDryRunsByDefault
    dryModeSelect.value = s.dryRunMode
    maxInput.value = String(s.maxHistoryPerChat)
  }

  return { root, update }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function setup(ctx: SpindleFrontendContext) {
  const cleanups: (() => void)[] = []

  const removeStyle = ctx.dom.addStyle(PANEL_CSS)
  cleanups.push(removeStyle)

  // ---- State ----
  let history: PromptSnapshot[] = []
  let currentChatId: string | null = null
  let settings: Settings = { ...DEFAULT_SETTINGS }
  let viewMode: 'formatted' | 'raw' | 'rendered' = settings.defaultViewMode
  let showDryRuns = settings.showDryRunsByDefault

  // ---- Permission request on startup ----
  ctx.permissions.getGranted().then((granted: string[]) => {
    const missing = GATED_PERMISSIONS.filter((p) => !granted.includes(p))
    if (missing.length === 0) return
    ctx.ui.showConfirm({
      title: 'Permissions Required',
      message: `Prompt Viewer needs the following permissions to function: ${missing.join(', ')}.`,
      variant: 'info',
      confirmLabel: 'Grant Permissions',
      cancelLabel: 'Not Now',
    }).then(({ confirmed }) => {
      if (confirmed) ctx.permissions.request(missing)
    })
  })

  // React to permission changes in real-time
  function handlePermissionChanged(payload: any): void {
    // API shape: { permission, granted, allGranted }
    if (payload.granted) {
      // Permission was just granted — refresh data
      ctx.sendToBackend({ type: 'get_history' })
    }
  }
  const unsubPermissionNew = ctx.events.on('PERMISSION_CHANGED', handlePermissionChanged)
  cleanups.push(unsubPermissionNew)

  // ---- Settings mount ----
  const settingsMount = ctx.ui.mount('settings_extensions')
  const settingsUI = createSettingsUI(settings, (newSettings) => {
    settings = newSettings
    viewMode = settings.defaultViewMode
    showDryRuns = settings.showDryRunsByDefault
    updateButtonStates()
    ctx.sendToBackend({ type: 'save_settings', settings })
  })
  settingsMount.appendChild(settingsUI.root)

  ctx.sendToBackend({ type: 'get_settings' })

  // ---- Drawer tab ----
  const tab = ctx.ui.registerDrawerTab({
    id: 'prompt-viewer',
    title: 'Prompt Viewer',
    shortName: 'Prompts',
    description: 'Inspect the assembled prompt sent to the LLM',
    keywords: ['prompt', 'inspector', 'debug', 'interceptor', 'raw'],
    headerTitle: 'Prompt Viewer',
    iconSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="20" height="20">
      <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v1H3V4zm0 3h14v9a1 1 0 01-1 1H4a1 1 0 01-1-1V7zm3 2v1h8V9H6zm0 3v1h5v-1H6z"/>
    </svg>`,
  })
  cleanups.push(() => tab.destroy())

  const unsubActivate = tab.onActivate(() => {
    ctx.sendToBackend({ type: 'get_history' })
  })
  cleanups.push(unsubActivate)

  const root = tab.root

  // ---- Toolbar ----
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

  const settingsBtn = document.createElement('button')
  settingsBtn.textContent = '⚙'
  settingsBtn.title = 'Settings'

  const spacer = document.createElement('span')
  spacer.className = 'pv-spacer'

  const status = document.createElement('span')
  status.className = 'pv-status'

  toolbar.append(select, refreshBtn, copyBtn, clearBtn, rawBtn, renderedBtn, dryRunBtn, settingsBtn, spacer, status)

  const messagesEl = document.createElement('div')
  messagesEl.className = 'pv-messages'

  root.append(toolbar, messagesEl)

  // ---- Rendering ----
  let currentSnapshot: PromptSnapshot | null = null

  function renderFormatted(snap: PromptSnapshot): void {
    const ctxBlock = document.createElement('div')
    ctxBlock.className = 'pv-context-block'
    const meta = snap.context as Record<string, unknown>
    // Use isSwipe flag to override the label when we know it's a swipe
    const rawGenType = String(meta.generationType ?? '')
    const genType = snap.isSwipe ? 'Swipe' : genTypeLabel(rawGenType)
    const worldInfoArr = Array.isArray(meta.activatedWorldInfo) ? meta.activatedWorldInfo as any[] : []
    const keywordEntries = worldInfoArr.filter((e) => e.source != null && e.source !== 'vector')
    const vectorEntries = worldInfoArr.filter((e) => e.source === 'vector')
    // Entries without a source field at all — may indicate a schema change
    const unknownEntries = worldInfoArr.filter((e) => e.source == null)

    let worldInfoLine: string | null = null
    if (worldInfoArr.length > 0) {
      const parts: string[] = []
      if (keywordEntries.length > 0) parts.push(`${keywordEntries.length} keyword`)
      if (vectorEntries.length > 0) parts.push(`${vectorEntries.length} vector`)
      if (unknownEntries.length > 0) parts.push(`${unknownEntries.length} untyped`)
      worldInfoLine = `World Info: ${worldInfoArr.length} entries (${parts.join(', ')})`
    }

    ctxBlock.textContent = [
      `Generation: ${genType}${snap.swipeIndex != null ? ` #${snap.swipeIndex}` : ''}${snap.wasAborted ? ' (aborted)' : ''}`,
      `Chat: ${meta.chatId ?? '?'}`,
      `Connection: ${meta.connectionId ?? '?'}`,
      `Persona: ${meta.personaId ?? '?'}`,
      snap.model ? `Model: ${snap.model}` : null,
      worldInfoLine,
    ].filter(Boolean).join('\n')
    messagesEl.appendChild(ctxBlock)

    // Show individual world info entries if any
    if (worldInfoArr.length > 0) {
      const wiBlock = document.createElement('div')
      wiBlock.className = 'pv-context-block pv-wi-block'
      wiBlock.textContent = worldInfoArr.map((e: any) => {
        // Determine source type — handle missing or renamed fields
        const src = e.source === 'vector'
          ? `vector (${typeof e.score === 'number' ? e.score.toFixed(4) : '?'})`
          : e.source != null ? String(e.source) : 'unknown'
        const name = e.comment || e.name || e.title || '(unnamed)'
        const keys = Array.isArray(e.keys)
          ? e.keys.join(', ')
          : Array.isArray(e.keywords) ? e.keywords.join(', ') : ''
        return `[${src}] ${name}${keys ? ` — keys: ${keys}` : ''}`
      }).join('\n')
      messagesEl.appendChild(wiBlock)
    }

    // Show regen feedback if present
    if (snap.regenFeedback) {
      const oocBlock = document.createElement('div')
      oocBlock.className = 'pv-context-block pv-ooc-block'
      oocBlock.textContent = `OOC Feedback (${snap.regenFeedbackPosition ?? 'user'}): ${snap.regenFeedback}`
      messagesEl.appendChild(oocBlock)
    }

    snap.messages.forEach((msg, i) => {
      const wrapper = document.createElement('div')
      wrapper.className = `pv-message pv-role-${msg.role}`
      const header = document.createElement('div')
      header.className = 'pv-message-header'
      const label = document.createElement('span')
      label.textContent = `#${i} — ${msg.name ? `${msg.role} (${msg.name})` : msg.role}`
      const badge = document.createElement('span')
      badge.className = 'pv-token-badge'
      badge.textContent = `~${Math.ceil(msgText(msg.content).length / 4)} tok`
      const toggle = document.createElement('span')
      toggle.className = 'pv-toggle'
      toggle.textContent = '▼'
      header.append(label, badge, toggle)
      const body = document.createElement('div')
      body.className = 'pv-message-body'
      body.textContent = msgText(msg.content)
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
    rawEl.textContent = JSON.stringify(snap.messages, null, 2)
    messagesEl.appendChild(rawEl)
  }

  function renderRendered(snap: PromptSnapshot): void {
    const rendered = document.createElement('div')
    rendered.className = 'pv-rendered'
    snap.messages.forEach((msg) => {
      if (!msg.content) return
      const text = msgText(msg.content)
      const block = document.createElement('div')
      block.className = 'pv-rendered-block'
      block.innerHTML = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
      rendered.appendChild(block)
    })
    messagesEl.appendChild(rendered)
  }

  function renderSnapshot(snap: PromptSnapshot | null): void {
    currentSnapshot = snap
    messagesEl.textContent = ''
    if (!snap) {
      const empty = document.createElement('div')
      empty.className = 'pv-empty'
      empty.textContent = 'No prompts captured yet.\nSend a message to see the assembled prompt here.'
      messagesEl.appendChild(empty)
      status.textContent = ''
      return
    }
    if (viewMode === 'raw') renderRaw(snap)
    else if (viewMode === 'rendered') renderRendered(snap)
    else renderFormatted(snap)

    const dryLabel = snap.isDryRun ? '[DRY RUN] ' : ''
    const abortLabel = snap.wasAborted ? '[ABORTED] ' : ''
    const msgLabel = snap.messageNumber ? `Msg #${snap.messageNumber} · ` : ''
    const swipeLabel = snap.swipeIndex != null ? `Swipe #${snap.swipeIndex} · ` : ''
    const apiLabel = snap.model ? `${snap.model} · ` : ''
    const tokPrefix = snap.approximateTokens === false ? '' : '~'
    const tokSuffix = snap.tokenizer ? ` (${snap.tokenizer})` : ''
    status.textContent = `${dryLabel}${abortLabel}${msgLabel}${swipeLabel}${apiLabel}${snap.messages.length} messages · ${tokPrefix}${snap.estimatedTokens} tok${tokSuffix} · ${formatTime(snap.timestamp)}`
  }

  function getFilteredHistory(): PromptSnapshot[] {
    if (!showDryRuns) return history.filter((s) => !s.isDryRun)
    if (settings.dryRunMode === 'alongside') return history
    return history.filter((s) => s.isDryRun)
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
      const oocTag = snap.regenFeedback ? '[OOC] ' : ''
      const abortTag = snap.wasAborted ? '[✗] ' : ''
      const rawGt = String((snap.context as any)?.generationType ?? '')
      const gt = snap.isSwipe ? 'Swipe' : genTypeLabel(rawGt)
      const swipeLabel = snap.swipeIndex != null ? `sw${snap.swipeIndex}` : ''
      const msgLabel = snap.messageNumber ? `#${snap.messageNumber}` : ''
      const locator = [msgLabel, swipeLabel].filter(Boolean).join('/')
      opt.textContent = `${prefix}${dryTag}${oocTag}${abortTag}${locator ? locator + ' · ' : ''}${formatTime(snap.timestamp)} · ${gt} · ${snap.messages.length} msgs`
      select.appendChild(opt)
    })
  }

  function updateBadge(): void {
    const filtered = getFilteredHistory()
    tab.setBadge(filtered.length > 0 ? String(filtered.length) : '')
  }

  function updateButtonStates(): void {
    rawBtn.classList.toggle('pv-active', viewMode === 'raw')
    rawBtn.textContent = viewMode === 'raw' ? '{ } Raw ✓' : '{ } Raw'
    renderedBtn.classList.toggle('pv-active', viewMode === 'rendered')
    renderedBtn.textContent = viewMode === 'rendered' ? '◉ Rendered ✓' : '◉ Rendered'
    dryRunBtn.classList.toggle('pv-active', showDryRuns)
    dryRunBtn.textContent = showDryRuns ? '⚡ Dry Runs ✓' : '⚡ Dry Runs'
  }

  // ---- Event handlers ----
  select.addEventListener('change', () => {
    const snap = history.find((s) => s.id === select.value) ?? null
    renderSnapshot(snap)
  })

  refreshBtn.addEventListener('click', () => ctx.sendToBackend({ type: 'get_history' }))

  settingsBtn.addEventListener('click', () => {
    ctx.events.emit('open-settings', { view: 'extensions' })
  })

  copyBtn.addEventListener('click', () => {
    if (!currentSnapshot) return
    let text: string
    if (viewMode === 'raw') {
      text = JSON.stringify(currentSnapshot.messages, null, 2)
    } else if (viewMode === 'rendered') {
      text = currentSnapshot.messages.map((m) => m.content).filter(Boolean).join('\n\n')
    } else {
      text = currentSnapshot.messages
        .map((m, i) => `--- [${i}] ${m.role}${m.name ? ` (${m.name})` : ''} ---\n${m.content}`)
        .join('\n\n')
    }
    copyToClipboard(text)
    copyBtn.textContent = '✓ Copied'
    setTimeout(() => { copyBtn.textContent = '⎘ Copy' }, 1500)
  })

  clearBtn.addEventListener('click', async () => {
    const { confirmed } = await ctx.ui.showConfirm({
      title: 'Clear Prompt History',
      message: 'Clear all captured prompts for this chat? This cannot be undone.',
      variant: 'danger',
      confirmLabel: 'Clear',
    })
    if (confirmed) ctx.sendToBackend({ type: 'clear_history' })
  })

  rawBtn.addEventListener('click', () => {
    viewMode = viewMode === 'raw' ? 'formatted' : 'raw'
    updateButtonStates()
    renderSnapshot(currentSnapshot)
  })

  renderedBtn.addEventListener('click', () => {
    viewMode = viewMode === 'rendered' ? 'formatted' : 'rendered'
    updateButtonStates()
    renderSnapshot(currentSnapshot)
  })

  dryRunBtn.addEventListener('click', () => {
    showDryRuns = !showDryRuns
    updateButtonStates()
    populateSelect()
    const filtered = getFilteredHistory()
    // If current snapshot isn't in the filtered set, switch to the first one
    if (currentSnapshot && !filtered.some((s) => s.id === currentSnapshot!.id)) {
      currentSnapshot = filtered[0] ?? null
      if (currentSnapshot) select.value = currentSnapshot.id
      renderSnapshot(currentSnapshot)
    }
    updateBadge()
  })

  // ---- Backend messages ----
  const unsubBackend = ctx.onBackendMessage((payload: any) => {
    switch (payload.type) {
      case 'prompt_captured': {
        const snapChatId = (payload.snapshot?.context as any)?.chatId
        if (snapChatId && currentChatId && snapChatId !== currentChatId) break
        if (!currentChatId && snapChatId) currentChatId = snapChatId
        history.unshift(payload.snapshot)
        if (history.length > settings.maxHistoryPerChat) history.pop()
        populateSelect()
        const isDry = payload.snapshot.isDryRun
        const isVisible = !showDryRuns
          ? !isDry
          : settings.dryRunMode === 'alongside' || isDry
        if (isVisible) {
          select.value = payload.snapshot.id
          renderSnapshot(payload.snapshot)
        }
        updateBadge()
        break
      }

      case 'prompt_history': {
        history = payload.snapshots ?? []
        populateSelect()
        const filtered = getFilteredHistory()
        if (filtered.length > 0) {
          select.value = filtered[0].id
          renderSnapshot(filtered[0])
        } else {
          renderSnapshot(null)
        }
        updateBadge()
        break
      }

      case 'prompt_data': {
        renderSnapshot(payload.snapshot ?? null)
        break
      }

      case 'history_cleared': {
        history = []
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
          select.value = filtered[0].id
          renderSnapshot(filtered[0])
        } else {
          renderSnapshot(null)
        }
        updateBadge()
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
              select.value = updated.id
              renderSnapshot(updated)
            }
          }
        }
        break
      }

      case 'settings_loaded': {
        if (payload.settings) {
          settings = { ...DEFAULT_SETTINGS, ...payload.settings }
          viewMode = settings.defaultViewMode
          showDryRuns = settings.showDryRunsByDefault
          updateButtonStates()
          settingsUI.update(settings)
        }
        break
      }
    }
  })
  cleanups.push(unsubBackend)

  // ---- Chat switch ----
  const unsubChatSwitched = ctx.events.on('CHAT_SWITCHED', (payload: any) => {
    const chatId = payload.chatId ?? null
    currentChatId = chatId
    if (chatId) {
      ctx.sendToBackend({ type: 'set_active_chat', chatId })
    } else {
      // User went to home screen
      history = []
      populateSelect()
      renderSnapshot(null)
      updateBadge()
    }
  })
  cleanups.push(unsubChatSwitched)

  // ---- Initial fetch ----
  ctx.sendToBackend({ type: 'get_history' })

  // ---- Cleanup ----
  return () => {
    for (const fn of cleanups) {
      try { fn() } catch {}
    }
    ctx.dom.cleanup()
  }
}
