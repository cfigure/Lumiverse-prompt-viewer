// =============================================================================
// prompt-viewer — Frontend
// =============================================================================

import type { SpindleFrontendContext } from 'lumiverse-spindle-types'
import { PANEL_CSS } from './components/styles'

type LlmMessagePartDTO =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; mime_type?: string }
  | { type: 'audio'; data?: string; mime_type?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }

interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmMessagePartDTO[]
  name?: string
}

type TokenCountSource = 'native' | 'native_approximate' | 'fallback'

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
  regenFeedbackRaw?: string
  regenFeedbackPosition?: 'system' | 'user'
  isSwipe?: boolean
  swipeIndex?: number
  wasAborted?: boolean
  approximateTokens?: boolean
  tokenCountSource?: TokenCountSource
  tokenModel?: string
  tokenModelSource?: 'main' | 'sidecar' | 'explicit'
  tokenizer?: string
  tokenizerError?: string
}

interface Settings {
  defaultViewMode: 'formatted' | 'raw' | 'rendered'
  showDryRunsByDefault: boolean
  dryRunMode: 'only' | 'alongside'
  showWorldInfo: boolean
  showRegenFeedback: boolean
  maxHistoryPerChat: number
  showTokenizerSource: boolean
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
  showWorldInfo: true,
  showRegenFeedback: true,
  maxHistoryPerChat: 50,
  showTokenizerSource: true,
}

const GATED_PERMISSIONS = ['interceptor', 'generation', 'chat_mutation', 'chats']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function msgText(content: string | LlmMessagePartDTO[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content.map((part) => {
    if (!part || typeof part !== 'object') return ''
    switch (part.type) {
      case 'text':
        return part.text ?? ''
      case 'image':
        return `[image${part.mime_type ? `: ${part.mime_type}` : ''}]`
      case 'audio':
        return `[audio${part.mime_type ? `: ${part.mime_type}` : ''}]`
      case 'tool_use':
        return `[tool_use${part.name ? `: ${part.name}` : ''}] ${JSON.stringify(part.input ?? {})}`
      case 'tool_result':
        return `[tool_result${part.is_error ? ' error' : ''}] ${part.content ?? ''}`
      default:
        return JSON.stringify(part)
    }
  }).filter(Boolean).join('\n')
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

function tokenSourceLabel(snap: PromptSnapshot): string {
  switch (snap.tokenCountSource) {
    case 'native': return snap.tokenizer ? `native: ${snap.tokenizer}` : 'native'
    case 'native_approximate': return snap.tokenizer ? `Lumiverse estimate: ${snap.tokenizer}` : 'Lumiverse estimate'
    case 'fallback': return 'fallback estimate'
    default: return snap.approximateTokens === false ? 'native' : 'estimate'
  }
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
type MountedHandle = { destroy?: () => void }

function createSettingsUI(
  ctx: SpindleFrontendContext,
  currentSettings: Settings,
  onChange: (s: Settings) => void,
): { root: HTMLElement; update: (s: Settings) => void; destroy: () => void } {
  let local = { ...currentSettings }
  const handles: MountedHandle[] = []
  const components = (ctx as any).components

  const root = document.createElement('div')
  root.className = 'pv-settings'

  const title = document.createElement('div')
  title.className = 'pv-settings-title'
  title.textContent = 'Prompt Viewer'
  root.appendChild(title)

  const card = document.createElement('div')
  card.className = 'pv-settings-card'
  root.appendChild(card)

  function destroyHandles(): void {
    handles.splice(0).forEach((handle) => {
      try { handle.destroy?.() } catch {}
    })
  }

  function commit(patch: Partial<Settings>, status: HTMLElement): void {
    local = { ...local, ...patch }
    onChange(local)
  }

  function fallbackSelect<T extends string>(value: T, options: { value: T; label: string }[], onValue: (v: T) => void): HTMLSelectElement {
    const sel = document.createElement('select')
    sel.className = 'pv-settings-input'
    for (const option of options) {
      const opt = document.createElement('option')
      opt.value = option.value
      opt.textContent = option.label
      if (option.value === value) opt.selected = true
      sel.appendChild(opt)
    }
    sel.addEventListener('change', () => onValue(sel.value as T))
    return sel
  }

  function build(): void {
    destroyHandles()
    card.textContent = ''

    const status = document.createElement('div')
    status.className = 'pv-settings-status'

    function addRow(label: string, input: HTMLElement, hint?: string): void {
      const row = document.createElement('div')
      row.className = 'pv-settings-row'

      const labelBlock = document.createElement('div')
      labelBlock.className = 'pv-settings-label-block'

      const lbl = document.createElement('label')
      lbl.className = 'pv-settings-label'
      lbl.textContent = label
      labelBlock.appendChild(lbl)

      if (hint) {
        const h = document.createElement('div')
        h.className = 'pv-settings-hint'
        h.textContent = hint
        labelBlock.appendChild(h)
      }

      const wrap = document.createElement('div')
      wrap.className = 'pv-settings-control'
      wrap.appendChild(input)

      row.append(labelBlock, wrap)
      card.appendChild(row)
    }

    function mountSelect<T extends string>(value: T, options: { value: T; label: string; sublabel?: string }[], onValue: (v: T) => void): HTMLElement {
      const slot = document.createElement('div')
      slot.className = 'pv-shared-slot'
      slot.appendChild(fallbackSelect(value, options, onValue))
      return slot
    }

    function mountSwitch(checked: boolean, label: string, onValue: (v: boolean) => void): HTMLElement {
      const slot = document.createElement('div')
      slot.className = 'pv-shared-slot'
      if (components?.mountSwitch) {
        handles.push(components.mountSwitch(slot, { checked, ariaLabel: label, onChange: onValue }))
      } else {
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = checked
        input.addEventListener('change', () => onValue(input.checked))
        slot.appendChild(input)
      }
      return slot
    }

    function mountStepper(value: number, onValue: (v: number) => void): HTMLElement {
      const slot = document.createElement('div')
      slot.className = 'pv-shared-slot'
      if (components?.mountNumberStepper) {
        handles.push(components.mountNumberStepper(slot, {
          value,
          min: 5,
          max: 500,
          step: 5,
          integer: true,
          onChange: (v: number | null) => onValue(Math.min(500, Math.max(5, v ?? 50))),
        }))
      } else {
        const input = document.createElement('input')
        input.className = 'pv-settings-input'
        input.type = 'number'
        input.min = '5'
        input.max = '500'
        input.value = String(value)
        input.addEventListener('change', () => onValue(Math.min(500, Math.max(5, parseInt(input.value) || 50))))
        slot.appendChild(input)
      }
      return slot
    }

    addRow('Default view mode', mountSelect(local.defaultViewMode, [
      { value: 'formatted', label: 'Formatted' },
      { value: 'raw', label: 'Raw' },
      { value: 'rendered', label: 'Rendered' },
    ], (value) => commit({ defaultViewMode: value }, status)))

    addRow('Show dry runs by default', mountSwitch(local.showDryRunsByDefault, 'Show dry runs by default', (checked) => commit({ showDryRunsByDefault: checked }, status)))
    addRow('Dry run display', mountSelect(local.dryRunMode, [
      { value: 'only', label: 'Dry runs only' },
      { value: 'alongside', label: 'Alongside normal prompts' },
    ], (value) => commit({ dryRunMode: value }, status)))
    addRow('Show World Info entries', mountSwitch(local.showWorldInfo, 'Show World Info entries', (checked) => commit({ showWorldInfo: checked }, status)))
    addRow('Show Regen Feedback at top', mountSwitch(local.showRegenFeedback, 'Show Regen Feedback at top', (checked) => commit({ showRegenFeedback: checked }, status)))
    addRow('Show tokenizer source', mountSwitch(local.showTokenizerSource, 'Show tokenizer source', (checked) => commit({ showTokenizerSource: checked }, status)))
    addRow('Max prompts per chat', mountStepper(local.maxHistoryPerChat, (value) => commit({ maxHistoryPerChat: value }, status)), 'Higher values use more memory. Prompt data is not persisted — history clears on restart.')
    card.appendChild(status)
  }

  build()

  function update(s: Settings): void {
    local = { ...s }
    build()
  }

  function destroy(): void {
    destroyHandles()
  }

  return { root, update, destroy }
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
  function backendPayload(payload: Record<string, unknown>): Record<string, unknown> {
    return currentChatId ? { ...payload, chatId: currentChatId } : payload
  }

  try {
    const active = ctx.getActiveChat?.()
    currentChatId = active?.chatId ?? null
  } catch {
    currentChatId = null
  }

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
      ctx.sendToBackend(backendPayload({ type: 'get_history' }))
    }
  }
  const unsubPermissionNew = ctx.events.on('PERMISSION_CHANGED', handlePermissionChanged)
  cleanups.push(unsubPermissionNew)

  // ---- Settings mount ----
  const settingsMount = ctx.ui.mount('settings_extensions')
  const settingsUI = createSettingsUI(ctx, settings, (newSettings) => {
    settings = newSettings
    viewMode = settings.defaultViewMode
    showDryRuns = settings.showDryRunsByDefault
    updateButtonStates()
    populateSelect()
    renderSnapshot(currentSnapshot)
    updateBadge()
    ctx.sendToBackend({ type: 'save_settings', settings })
    ctx.sendToBackend(backendPayload({ type: 'get_history' }))
  })
  settingsMount.appendChild(settingsUI.root)
  cleanups.push(() => { settingsUI.destroy(); settingsUI.root.remove() })

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
    ctx.sendToBackend(backendPayload({ type: 'get_history' }))
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

    // Sort for display: vector entries first (by score descending), then keyword, then untyped
    const sortedWorldInfo = [...worldInfoArr].sort((a, b) => {
      const aIsVector = a.source === 'vector' ? 0 : a.source != null ? 1 : 2
      const bIsVector = b.source === 'vector' ? 0 : b.source != null ? 1 : 2
      if (aIsVector !== bIsVector) return aIsVector - bIsVector
      // Within vector entries, sort by score descending
      if (aIsVector === 0 && bIsVector === 0) {
        return (typeof b.score === 'number' ? b.score : 0) - (typeof a.score === 'number' ? a.score : 0)
      }
      return 0
    })

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

    // Regen Feedback banner — mirrors the native Prompt Breakdown's two-line
    // layout: "Regen Feedback" heading on top, raw `[OOC: ...]` content below.
    // Uses the raw matched string so the banner shows exactly what was injected
    // into the assembled prompt (rather than reconstructing it from inner text).
    // Position label reflects the slot the OOC marker actually occupies in the
    // assembled prompt — see detectRegenFeedback() in backend.ts.
    if (snap.regenFeedback && settings.showRegenFeedback) {
      const oocBanner = document.createElement('div')
      oocBanner.className = 'pv-context-block pv-ooc-block'
      const heading = document.createElement('div')
      heading.className = 'pv-ooc-heading'
      heading.textContent = snap.regenFeedbackPosition
        ? `Regen Feedback (${snap.regenFeedbackPosition})`
        : 'Regen Feedback'
      const body = document.createElement('div')
      body.className = 'pv-ooc-body'
      body.textContent = snap.regenFeedbackRaw ?? `[OOC: ${snap.regenFeedback}]`
      oocBanner.append(heading, body)
      messagesEl.appendChild(oocBanner)
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
    if (worldInfoArr.length > 0 && settings.showWorldInfo) {
      const wiBlock = document.createElement('div')
      wiBlock.className = 'pv-context-block pv-wi-block'
      wiBlock.textContent = sortedWorldInfo.map((e: any) => {
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
      const text = msgText(msg.content)
      if (!text) return
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
    const msgLabel = snap.messageNumber != null ? `Msg #${snap.messageNumber} · ` : ''
    const swipeLabel = snap.swipeIndex != null ? `Swipe #${snap.swipeIndex} · ` : ''
    const apiLabel = snap.model ? `${snap.model} · ` : ''
    const tokPrefix = snap.approximateTokens === false ? '' : '~'
    const source = settings.showTokenizerSource ? ` · ${tokenSourceLabel(snap)}` : ''
    status.textContent = `${dryLabel}${abortLabel}${msgLabel}${swipeLabel}${apiLabel}${snap.messages.length} messages · ${tokPrefix}${snap.estimatedTokens} tok${source} · ${formatTime(snap.timestamp)}`
    if (snap.tokenizerError) status.title = `Native token count failed: ${snap.tokenizerError}`
    else status.title = snap.tokenModel ? `Token model: ${snap.tokenModel}${snap.tokenModelSource ? ` (${snap.tokenModelSource})` : ''}` : ''
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
      const msgLabel = snap.messageNumber != null ? `#${snap.messageNumber}` : ''
      const locator = [msgLabel, swipeLabel].filter(Boolean).join('/')
      opt.textContent = `${prefix}${dryTag}${abortTag}${oocTag}${locator ? locator + ' · ' : ''}${formatTime(snap.timestamp)} · ${gt} · ${snap.messages.length} msgs`
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

  refreshBtn.addEventListener('click', () => ctx.sendToBackend(backendPayload({ type: 'get_history' })))

  settingsBtn.addEventListener('click', () => {
    ctx.events.emit('open-settings', { view: 'extensions' })
  })

  copyBtn.addEventListener('click', () => {
    if (!currentSnapshot) return
    let text: string
    if (viewMode === 'raw') {
      text = JSON.stringify(currentSnapshot.messages, null, 2)
    } else if (viewMode === 'rendered') {
      text = currentSnapshot.messages.map((m) => msgText(m.content)).filter(Boolean).join('\n\n')
    } else {
      text = currentSnapshot.messages
        .map((m, i) => `--- [${i}] ${m.role}${m.name ? ` (${m.name})` : ''} ---\n${msgText(m.content)}`)
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
    if (confirmed) ctx.sendToBackend(backendPayload({ type: 'clear_history' }))
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
        const snap = payload.snapshot as PromptSnapshot
        const snapChatId = (snap?.context as any)?.chatId
        if (snapChatId && currentChatId && snapChatId !== currentChatId) break
        if (!currentChatId && snapChatId) currentChatId = snapChatId
        history.unshift(snap)
        if (history.length > settings.maxHistoryPerChat) history.pop()
        populateSelect()
        const isDry = snap.isDryRun
        const isVisible = !showDryRuns
          ? !isDry
          : settings.dryRunMode === 'alongside' || isDry
        if (isVisible) {
          select.value = snap.id
          renderSnapshot(snap)
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
          populateSelect()
          renderSnapshot(currentSnapshot)
          updateBadge()
          ctx.sendToBackend(backendPayload({ type: 'get_history' }))
        }
        break
      }
    }
  })
  cleanups.push(unsubBackend)

  // ---- Initial fetch ----
  ctx.sendToBackend(backendPayload({ type: 'get_history' }))

  // ---- Cleanup ----
  return () => {
    for (const fn of cleanups) {
      try { fn() } catch {}
    }
    ctx.dom.cleanup()
  }
}
