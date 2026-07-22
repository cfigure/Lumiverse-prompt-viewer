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
  isAutoDryRun?: boolean
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
  rejectedMessage?: string
  parameters?: Record<string, unknown>
  provider?: string
  presetName?: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  maxContext?: number
}

interface Settings {
  defaultViewMode: 'formatted' | 'raw' | 'rendered'
  showDryRunsByDefault: boolean
  dryRunMode: 'only' | 'alongside'
  showWorldInfo: boolean
  showRegenFeedback: boolean
  maxHistoryPerChat: number
  showTokenizerSource: boolean
  hideInternalMarkers: boolean
  renderedBreakdownStyle: boolean
  hideAutoDryRuns: boolean
  expandPromptBlocks: boolean
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
  showWorldInfo: true,
  showRegenFeedback: true,
  maxHistoryPerChat: 50,
  showTokenizerSource: true,
  hideInternalMarkers: false,
  renderedBreakdownStyle: false,
  hideAutoDryRuns: false,
  expandPromptBlocks: false,
}

// Keys the host stamps onto interceptor messages for assembly bookkeeping.
// Underscore-prefixed keys (_fromSystem, __isChatHistory, __isWorldInfoEntry, …)
// are caught by prefix; these two are named because they aren't prefixed.
const INTERNAL_MARKER_KEYS = new Set(['sourceMessageId', 'sourceIndexInChat'])

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
      { value: 'raw', label: 'JSON' },
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
    addRow('Hide Lumiverse markers in JSON', mountSwitch(local.hideInternalMarkers, 'Hide Lumiverse markers in JSON', (checked) => commit({ hideInternalMarkers: checked }, status)), 'Hides internal assembly bookkeeping keys (_fromSystem, __isChatHistory, sourceMessageId, …) from the JSON view and JSON copy. Display-only — the capture stays lossless.')
    addRow('Hide automatic chat-entry dry runs', mountSwitch(local.hideAutoDryRuns, 'Hide automatic chat-entry dry runs', (checked) => commit({ hideAutoDryRuns: checked }, status)), 'Some extensions trigger a dry run when you enter a chat. These are tagged by timing (captured within a few seconds of switching chats) and hidden from views and the badge — still stored, and shown with an [auto] tag when this is off.')
    addRow('Prompt Breakdown-style Rendered', mountSwitch(local.renderedBreakdownStyle, 'Prompt Breakdown-style Rendered', (checked) => commit({ renderedBreakdownStyle: checked }, status)), 'Adds a # provider / model heading, ### [N] ROLE separators, and a ### PARAMETERS tail to the Rendered view and its copy, matching the native Prompt Breakdown Raw output.')
    addRow('Expand prompt blocks to full height', mountSwitch(local.expandPromptBlocks, 'Expand prompt blocks to full height', (checked) => commit({ expandPromptBlocks: checked }, status)), 'Off preserves the 1.0.7-style 400px cap with internal scrolling. On lets prompt messages, regeneration feedback, World Info, and the connection/parameter summary grow to fit their full content.')
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
  rawBtn.textContent = '{ } JSON'

  const renderedBtn = document.createElement('button')
  renderedBtn.textContent = '◉ Rendered'

  const dryRunBtn = document.createElement('button')
  dryRunBtn.textContent = '⚡ Dry Runs'

  const collapseAllBtn = document.createElement('button')
  collapseAllBtn.textContent = '▼ All'
  collapseAllBtn.title = 'Collapse or expand all blocks'

  const settingsBtn = document.createElement('button')
  settingsBtn.textContent = '⚙'
  settingsBtn.title = 'Settings'

  const spacer = document.createElement('span')
  spacer.className = 'pv-spacer'

  const status = document.createElement('span')
  status.className = 'pv-status'

  toolbar.append(select, refreshBtn, copyBtn, clearBtn, rawBtn, renderedBtn, dryRunBtn, collapseAllBtn, settingsBtn, spacer, status)

  const messagesEl = document.createElement('div')
  messagesEl.className = 'pv-messages'

  root.append(toolbar, messagesEl)

  // ---- Rendering ----
  let currentSnapshot: PromptSnapshot | null = null

  // Collapse/expand-all registry. Rebuilt on every render; the toolbar button
  // acts on whatever blocks the current formatted view produced.
  let blockControls: { setCollapsed: (c: boolean) => void }[] = []
  let allCollapsed = false

  function updateCollapseAllLabel(): void {
    collapseAllBtn.textContent = allCollapsed ? '▶ All' : '▼ All'
  }

  function makeCollapsible(
    header: HTMLElement,
    body: HTMLElement,
    toggle: HTMLElement,
    startCollapsed = false,
    onChange?: (collapsed: boolean) => void,
  ): { setCollapsed: (c: boolean) => void } {
    let collapsed = startCollapsed
    const apply = () => {
      body.classList.toggle('pv-collapsed', collapsed)
      toggle.textContent = collapsed ? '▶' : '▼'
      onChange?.(collapsed)
    }
    apply()
    header.addEventListener('click', () => {
      collapsed = !collapsed
      apply()
    })
    const ctl = {
      setCollapsed(c: boolean) {
        collapsed = c
        apply()
      },
    }
    blockControls.push(ctl)
    return ctl
  }

  // Per-block copy. Lives inside the clickable header, so stopPropagation
  // keeps the 1.0.7 collapse behavior intact everywhere except the button.
  function addHeaderCopy(parent: HTMLElement, getText: () => string): void {
    const btn = document.createElement('button')
    let resetTimer: ReturnType<typeof setTimeout> | null = null

    btn.type = 'button'
    btn.className = 'pv-block-copy'
    btn.textContent = 'Copy'
    btn.title = 'Copy this block'
    btn.setAttribute('aria-label', 'Copy this block')
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      copyToClipboard(getText())
      btn.textContent = '✓ Copied'
      btn.setAttribute('aria-label', 'Copied')

      if (resetTimer !== null) clearTimeout(resetTimer)
      resetTimer = setTimeout(() => {
        btn.textContent = 'Copy'
        btn.setAttribute('aria-label', 'Copy this block')
        resetTimer = null
      }, 1500)
    })
    parent.appendChild(btn)
  }

  // JSON view / JSON copy text. Mirrors the native Prompt Breakdown's export
  // shape: { messages, parameters?, model?, provider? } — parameters/model/
  // provider are omitted when not yet known (e.g. a dry run before the
  // connection lookup resolves). NOTE: 1.0.8 changed the top level from a bare
  // message array to this object. When the hide-markers setting is on, drops
  // underscore-prefixed keys plus the named non-prefixed markers at display
  // time only — the stored snapshot stays lossless.
  function rawJson(snap: PromptSnapshot): string {
    const payload: Record<string, unknown> = { messages: snap.messages }
    if (snap.parameters && Object.keys(snap.parameters).length > 0) payload.parameters = snap.parameters
    if (snap.model) payload.model = snap.model
    if (snap.provider) payload.provider = snap.provider
    if (!settings.hideInternalMarkers) return JSON.stringify(payload, null, 2)
    return JSON.stringify(
      payload,
      (key, value) => (key.startsWith('_') || INTERNAL_MARKER_KEYS.has(key) ? undefined : value),
      2,
    )
  }

  // Rendered view text in Prompt Breakdown style: `# provider / model`
  // heading, `### [N] ROLE` separators, `### PARAMETERS` tail. Shared by the
  // Rendered copy path so clipboard always matches the screen.
  function renderedBreakdownSegments(snap: PromptSnapshot): { kind: 'heading' | 'separator' | 'text'; text: string }[] {
    const segments: { kind: 'heading' | 'separator' | 'text'; text: string }[] = []
    if (snap.provider || snap.model) {
      segments.push({ kind: 'heading', text: `# ${[snap.provider, snap.model].filter(Boolean).join(' / ')}` })
    }
    snap.messages.forEach((msg, i) => {
      const text = msgText(msg.content)
      if (!text) return
      segments.push({ kind: 'separator', text: `### [${i + 1}] ${msg.role.toUpperCase()}` })
      segments.push({ kind: 'text', text })
    })
    if (snap.parameters && Object.keys(snap.parameters).length > 0) {
      segments.push({ kind: 'separator', text: '### PARAMETERS' })
      segments.push({ kind: 'text', text: JSON.stringify(snap.parameters, null, 2) })
    }
    return segments
  }

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

    const usageLine = snap.usage && (snap.usage.prompt_tokens != null || snap.usage.completion_tokens != null)
      ? `Usage: ${snap.usage.prompt_tokens ?? '?'} prompt / ${snap.usage.completion_tokens ?? '?'} completion tokens`
      : null

    // Flat key: value lines to match the rest of the context box — the JSON
    // view and PB-style Rendered keep the JSON form. Non-primitive values
    // (e.g. logit_bias maps) are compact-stringified on one line.
    const paramsLines = snap.parameters && Object.keys(snap.parameters).length > 0
      ? 'Parameters:\n' + Object.entries(snap.parameters)
          .map(([k, v]) => `  ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
          .join('\n')
      : null

    ctxBlock.textContent = [
      `Generation: ${genType}${snap.swipeIndex != null ? ` #${snap.swipeIndex}` : ''}${snap.wasAborted ? ' (aborted)' : ''}`,
      `Chat: ${meta.chatId ?? '?'}`,
      `Connection: ${meta.connectionId ?? '?'}`,
      `Persona: ${meta.personaId ?? '?'}`,
      snap.model ? `Model: ${snap.model}` : null,
      snap.provider ? `Provider: ${snap.provider}` : null,
      snap.presetName ? `Preset: ${snap.presetName}` : null,
      snap.maxContext ? `Max context: ${snap.maxContext}` : null,
      usageLine,
      worldInfoLine,
      paramsLines,
    ].filter(Boolean).join('\n')
    messagesEl.appendChild(ctxBlock)

    if ((snap.regenFeedback || snap.rejectedMessage) && settings.showRegenFeedback) {
      const oocBanner = document.createElement('div')
      oocBanner.className = 'pv-context-block pv-ooc-block'
      const heading = document.createElement('div')
      heading.className = 'pv-ooc-heading'
      heading.textContent = snap.regenFeedbackPosition
        ? `Regen Feedback (${snap.regenFeedbackPosition})`
        : 'Regen Feedback'
      addHeaderCopy(heading, () => snap.regenFeedbackRaw ?? `[OOC: ${snap.regenFeedback ?? ''}]`)
      const body = document.createElement('div')
      body.className = 'pv-ooc-body'
      // When the rejected-message wrapper was detected, the banner shows only
      // the user's actual feedback; the (potentially huge) rejected message
      // lives in its own collapsible block below. Plain OOCs keep the 1.0.7
      // raw-marker display.
      body.textContent = snap.rejectedMessage !== undefined
        ? (snap.regenFeedback || '(no feedback text)')
        : (snap.regenFeedbackRaw ?? `[OOC: ${snap.regenFeedback}]`)
      oocBanner.append(heading, body)

      if (snap.rejectedMessage !== undefined) {
        const rejWrapper = document.createElement('div')
        rejWrapper.className = 'pv-message pv-rejected-block'
        const rejHeader = document.createElement('div')
        rejHeader.className = 'pv-message-header'
        const rejLabel = document.createElement('span')
        rejLabel.textContent = 'Rejected message (sent for reference)'
        const rejRight = document.createElement('span')
        rejRight.className = 'pv-header-right'
        const rejBadge = document.createElement('span')
        rejBadge.className = 'pv-token-badge'
        rejBadge.textContent = `~${Math.ceil(snap.rejectedMessage.length / 4)} tok`
        rejRight.appendChild(rejBadge)
        addHeaderCopy(rejRight, () => snap.rejectedMessage ?? '')
        const rejToggle = document.createElement('span')
        rejToggle.className = 'pv-toggle'
        rejRight.appendChild(rejToggle)
        rejHeader.append(rejLabel, rejRight)
        const rejBody = document.createElement('div')
        rejBody.className = 'pv-message-body'
        rejBody.textContent = snap.rejectedMessage
        // Starts collapsed — it duplicates a full prior message. Expanding it
        // also releases the parent OOC banner's compact height constraint so
        // the full rejected message is visible without a nested scrollbar.
        makeCollapsible(rejHeader, rejBody, rejToggle, true, (collapsed) => {
          oocBanner.classList.toggle('pv-ooc-expanded', !collapsed)
        })
        rejWrapper.append(rejHeader, rejBody)
        oocBanner.appendChild(rejWrapper)
      }

      messagesEl.appendChild(oocBanner)
    }

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
      const text = msgText(msg.content)
      const wrapper = document.createElement('div')
      wrapper.className = `pv-message pv-role-${msg.role}`
      const header = document.createElement('div')
      header.className = 'pv-message-header'
      const label = document.createElement('span')
      label.textContent = `#${i} — ${msg.name ? `${msg.role} (${msg.name})` : msg.role}`
      const right = document.createElement('span')
      right.className = 'pv-header-right'
      const badge = document.createElement('span')
      badge.className = 'pv-token-badge'
      badge.textContent = `~${Math.ceil(text.length / 4)} tok`
      right.appendChild(badge)
      addHeaderCopy(right, () => text)
      const toggle = document.createElement('span')
      toggle.className = 'pv-toggle'
      right.appendChild(toggle)
      header.append(label, right)
      const body = document.createElement('div')
      body.className = 'pv-message-body'
      body.textContent = text
      makeCollapsible(header, body, toggle)
      wrapper.append(header, body)
      messagesEl.appendChild(wrapper)
    })
  }

  function renderRaw(snap: PromptSnapshot): void {
    const rawEl = document.createElement('div')
    rawEl.className = 'pv-raw'
    rawEl.textContent = rawJson(snap)
    messagesEl.appendChild(rawEl)
  }

  function renderRendered(snap: PromptSnapshot): void {
    const rendered = document.createElement('div')
    rendered.className = 'pv-rendered'

    const escapeToHtml = (text: string) => text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')

    if (settings.renderedBreakdownStyle) {
      for (const seg of renderedBreakdownSegments(snap)) {
        const block = document.createElement('div')
        block.className = seg.kind === 'text' ? 'pv-rendered-block' : 'pv-rendered-sep'
        if (seg.kind === 'text') block.innerHTML = escapeToHtml(seg.text)
        else block.textContent = seg.text
        rendered.appendChild(block)
      }
    } else {
      snap.messages.forEach((msg) => {
        const text = msgText(msg.content)
        if (!text) return
        const block = document.createElement('div')
        block.className = 'pv-rendered-block'
        block.innerHTML = escapeToHtml(text)
        rendered.appendChild(block)
      })
    }
    messagesEl.appendChild(rendered)
  }

  function renderSnapshot(snap: PromptSnapshot | null): void {
    currentSnapshot = snap
    messagesEl.classList.toggle('pv-full-height', settings.expandPromptBlocks)
    messagesEl.textContent = ''
    // Fresh render → fresh block registry, expanded by default (matches the
    // per-block toggles, which also reset when switching snapshots).
    blockControls = []
    allCollapsed = false
    updateCollapseAllLabel()
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

    const dryLabel = snap.isAutoDryRun ? '[AUTO DRY RUN] ' : snap.isDryRun ? '[DRY RUN] ' : ''
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
    const base = settings.hideAutoDryRuns ? history.filter((s) => !s.isAutoDryRun) : history
    if (!showDryRuns) return base.filter((s) => !s.isDryRun)
    if (settings.dryRunMode === 'alongside') return base
    return base.filter((s) => s.isDryRun)
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
      const dryTag = snap.isAutoDryRun ? '[DRY·auto] ' : snap.isDryRun ? '[DRY] ' : ''
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
    rawBtn.textContent = viewMode === 'raw' ? '{ } JSON ✓' : '{ } JSON'
    renderedBtn.classList.toggle('pv-active', viewMode === 'rendered')
    renderedBtn.textContent = viewMode === 'rendered' ? '◉ Rendered ✓' : '◉ Rendered'
    dryRunBtn.classList.toggle('pv-active', showDryRuns)
    dryRunBtn.textContent = showDryRuns ? '⚡ Dry Runs ✓' : '⚡ Dry Runs'
    // Collapsible blocks only exist in the formatted view. Hide the control
    // entirely in JSON and Rendered so the toolbar only exposes relevant actions.
    collapseAllBtn.classList.toggle('pv-view-hidden', viewMode !== 'formatted')
  }

  collapseAllBtn.addEventListener('click', () => {
    allCollapsed = !allCollapsed
    for (const ctl of blockControls) ctl.setCollapsed(allCollapsed)
    updateCollapseAllLabel()
  })

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
      // Matches the on-screen JSON view: filtered when hide-markers is on.
      text = rawJson(currentSnapshot)
    } else if (viewMode === 'rendered') {
      text = settings.renderedBreakdownStyle
        ? renderedBreakdownSegments(currentSnapshot).map((s) => s.text).join('\n\n')
        : currentSnapshot.messages.map((m) => msgText(m.content)).filter(Boolean).join('\n\n')
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
        const hiddenAuto = snap.isAutoDryRun && settings.hideAutoDryRuns
        const isVisible = !hiddenAuto && (!showDryRuns
          ? !isDry
          : settings.dryRunMode === 'alongside' || isDry)
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
