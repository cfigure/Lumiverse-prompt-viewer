// =============================================================================
// prompt-viewer — Backend (Bun worker)
// =============================================================================

import { PromptStore } from './storage/prompt-store'
import type { PromptSnapshot, LlmMessage, InterceptorMeta, TokenCountSource } from './storage/prompt-store'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const store = new PromptStore()
let activeChatId: string | null = null
let currentUserId: string | undefined

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
interface Settings {
  defaultViewMode: 'formatted' | 'raw' | 'rendered'
  showDryRunsByDefault: boolean
  dryRunMode: 'only' | 'alongside'
  showWorldInfo: boolean
  showRegenFeedback: boolean
  maxHistoryPerChat: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
  showWorldInfo: true,
  showRegenFeedback: true,
  maxHistoryPerChat: 50,
}

async function loadSettings(): Promise<Settings> {
  try {
    const saved = await spindle.userStorage.getJson<Partial<Settings>>('settings.json', {
      fallback: {},
      userId: currentUserId,
    })
    const settings = { ...DEFAULT_SETTINGS, ...saved }
    store.setMaxPerChat(settings.maxHistoryPerChat)
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(settings: Settings): Promise<void> {
  await spindle.userStorage.setJson('settings.json', settings, {
    indent: 2,
    userId: currentUserId,
  })
  store.setMaxPerChat(settings.maxHistoryPerChat)
}

// ---------------------------------------------------------------------------
// Content helpers — LlmMessageDTO.content may be a string or typed parts.
// Keep prompt capture lossless, but use a readable text projection for search,
// OOC detection, display token estimates, and clipboard paths.
// ---------------------------------------------------------------------------
type LlmMessagePartDTO =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; mime_type?: string }
  | { type: 'audio'; data?: string; mime_type?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }

type LlmMessageContent = string | LlmMessagePartDTO[]

function messageText(content: LlmMessageContent): string {
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

function messageTextCandidates(content: LlmMessageContent): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const candidates = [messageText(content)]
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') candidates.push(part.text)
    if (part?.type === 'tool_result' && typeof part.content === 'string') candidates.push(part.content)
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Regen feedback detector
//
// Inspects the assembled messages for the `[OOC: ...]` marker that the
// Lumiverse prompt assembler injects when the user supplies feedback in the
// regen modal. Detection is intentionally NOT gated on generationType:
//
//   - swipe button / swipe arrow → generationType: 'regenerate'
//   - composer regen button       → generationType: 'normal' (Lumiverse does
//                                   not distinguish this from a fresh send)
//   - explicit swipe-add path     → generationType: 'swipe'
//
// Because the composer-regen path arrives as 'normal', gating on type would
// silently suppress the banner there. The OOC marker itself is a stable signal
// — present iff the user supplied feedback — so we trust it on every path.
//
// Matching rules mirror prompt-assembly.service.ts:2150-2208 exactly:
//   - 'system' position: a trailing system-role message whose ENTIRE content
//                        matches `^[OOC: <body>]$` with no leading/trailing
//                        whitespace.
//   - 'user'   position: a trailing user-role message whose content ENDS
//                        with `\n[OOC: <body>]`. The newline separator is
//                        required to avoid catching brackets that happen to
//                        appear at the end of a user-authored sentence.
//
// `<body>` is non-greedy across newlines so multi-line feedback is captured.
// We anchor strictly to the end-of-string so additional content after the
// closing bracket disqualifies the match (defensive — assembler doesn't
// produce that today).
//
// CAVEAT: a user who types `\n[OOC: ...]` at the end of their own message
// (without using the regen modal) will trigger detection. This matches what
// the native Prompt Breakdown does — prompt-assembly tags any such injection
// as a "Regen Feedback" utility entry regardless of source. We can't be more
// truthful than the host here.
// ---------------------------------------------------------------------------
const SYSTEM_OOC_RE = /^(\[OOC:\s*([\s\S]*?)\])$/
const TRAILING_USER_OOC_RE = /\n(\[OOC:\s*([\s\S]*?)\])$/

interface RegenFeedbackDetection {
  /** Inner text only (body between `[OOC:` and `]`, trimmed). */
  text: string
  /** Raw matched marker including `[OOC: ]` wrapper, exactly as injected. */
  raw: string
  /** Which slot the marker appeared in. Detection-driven, not user-setting-driven. */
  position: 'system' | 'user'
}

function detectRegenFeedback(messages: LlmMessage[]): RegenFeedbackDetection | null {
  if (!messages.length) return null

  // Walk backwards from the end. The assembler injects at the tail in both
  // positions, and on regen/swipe paths nothing further mutates the tail
  // before the interceptor runs.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const candidates = messageTextCandidates(msg.content)
    if (candidates.length === 0) continue

    if (msg.role === 'system') {
      for (const content of candidates) {
        const m = SYSTEM_OOC_RE.exec(content)
        if (m) return { text: m[2].trim(), raw: m[1], position: 'system' }
      }
      // A system message that ISN'T a pure OOC marker is fine — keep walking.
      // The assembler can leave other system messages at the tail (e.g.
      // depth-injected blocks), so non-match here is not a stop condition.
      continue
    }

    if (msg.role === 'user') {
      for (const content of candidates) {
        const m = TRAILING_USER_OOC_RE.exec(content) || SYSTEM_OOC_RE.exec(content)
        if (m) return { text: m[2].trim(), raw: m[1], position: 'user' }
      }
      // Tail user message without the marker: feedback wasn't injected
      // in 'user' position. Stop — looking further back would risk picking
      // up older OOC text from earlier turns.
      return null
    }

    // assistant or other roles — skip and keep looking
  }

  return null
}

// ---------------------------------------------------------------------------
// Token counting — uses Lumiverse's tokenization surface when available,
// falls back to chars/4 estimate if the API call fails.
// ---------------------------------------------------------------------------
function estimateTokensFallback(messages: LlmMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    chars += (msg.role?.length ?? 0) + messageText(msg.content).length
  }
  return Math.ceil(chars / 4)
}

async function countTokens(
  messages: LlmMessage[],
  model?: string,
  userId?: string,
): Promise<{
  tokens: number
  approximate: boolean
  source: TokenCountSource
  tokenizer?: string
  tokenModel?: string
  tokenModelSource?: 'main' | 'sidecar' | 'explicit'
  error?: string
}> {
  try {
    const opts: { model?: string; modelSource?: 'main'; userId?: string } = {}
    if (model) opts.model = model
    else opts.modelSource = 'main'
    if (userId) opts.userId = userId

    // Native countMessages currently requires string content. Keep the captured
    // messages lossless, but send Lumiverse a text projection for counting.
    const result = await spindle.tokens.countMessages(
      messages.map((m) => ({ role: m.role, content: messageText(m.content) })),
      opts,
    )
    return {
      tokens: result.total_tokens,
      approximate: result.approximate,
      source: result.approximate ? 'native_approximate' : 'native',
      tokenizer: result.tokenizer_name,
      tokenModel: result.model,
      tokenModelSource: result.modelSource,
    }
  } catch (err: any) {
    const error = err?.message ?? String(err)
    spindle.log.warn(`Prompt Viewer native token count failed; using chars/4 fallback: ${error}`)
    return {
      tokens: estimateTokensFallback(messages),
      approximate: true,
      source: 'fallback',
      error,
    }
  }
}

// ---------------------------------------------------------------------------
// Dry-run detection — track active generation IDs
// ---------------------------------------------------------------------------
interface ActiveGenerationMeta {
  chatId?: string
  model?: string
  generationType?: string
  targetMessageId?: string
}

const activeGenerations = new Map<string, ActiveGenerationMeta>()
const pendingSwipeAdds = new Map<string, { swipeIndex?: number; timestamp: number }>()

function swipeKey(chatId?: string, messageId?: string): string | null {
  return chatId && messageId ? `${chatId}:${messageId}` : null
}

function getActiveGenerationForChat(chatId?: string): { generationId: string; meta: ActiveGenerationMeta } | null {
  let fallback: { generationId: string; meta: ActiveGenerationMeta } | null = null
  for (const [generationId, meta] of activeGenerations) {
    const entry = { generationId, meta }
    fallback = entry
    if (chatId && meta.chatId === chatId) return entry
  }
  return activeGenerations.size === 1 ? fallback : null
}

function prunePendingSwipes(now = Date.now()): void {
  for (const [key, value] of pendingSwipeAdds) {
    if (now - value.timestamp > 5 * 60 * 1000) pendingSwipeAdds.delete(key)
  }
}

// ---------------------------------------------------------------------------
// Permission-gated feature registration
//
// Generation events and the interceptor require gated permissions. If we
// register them at top-level before the user has granted permissions, the
// host rejects them silently. Instead, we check permissions synchronously
// at startup and also listen for live permission grants so we register as
// soon as the permission becomes available.
// ---------------------------------------------------------------------------
let interceptorRegistered = false
let generationEventsRegistered = false

function tryRegisterInterceptor(): void {
  if (interceptorRegistered) return
  if (!spindle.permissions.has('interceptor')) return

  spindle.registerInterceptor(async (messages, context) => {
    try {
      const ctx = context as InterceptorMeta

      const capturedMessages = structuredClone(messages) as LlmMessage[]
      const snapshot: PromptSnapshot = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        messages: capturedMessages,
        context: structuredClone(ctx),
        estimatedTokens: estimateTokensFallback(capturedMessages),
        tokenCountSource: 'fallback',
        approximateTokens: true,
      }

      // Pull model/generation metadata from GENERATION_STARTED. Match by chatId
      // so simultaneous generations in another chat do not incorrectly mark
      // this prompt as live, attach the wrong model, or suppress dry-run labels.
      const active = getActiveGenerationForChat(ctx.chatId)
      snapshot.isDryRun = !active
      if (active) {
        snapshot.generationId = active.generationId
        if (active.meta.model) snapshot.model = active.meta.model

        const key = swipeKey(ctx.chatId, active.meta.targetMessageId)
        const pendingSwipe = key ? pendingSwipeAdds.get(key) : null
        if (pendingSwipe || active.meta.generationType === 'swipe') {
          snapshot.isSwipe = true
          if (pendingSwipe?.swipeIndex !== undefined) snapshot.swipeIndex = pendingSwipe.swipeIndex
        }
      }

      // Async token count — fire and forget, update snapshot when ready
      countTokens(capturedMessages, snapshot.model, currentUserId).then((result) => {
        snapshot.estimatedTokens = result.tokens
        snapshot.approximateTokens = result.approximate
        snapshot.tokenCountSource = result.source
        if (result.tokenizer) snapshot.tokenizer = result.tokenizer
        if (result.tokenModel) snapshot.tokenModel = result.tokenModel
        if (result.tokenModelSource) snapshot.tokenModelSource = result.tokenModelSource
        if (result.error) snapshot.tokenizerError = result.error
        spindle.sendToFrontend({ type: 'snapshot_updated', snapshot })
      })

      // OOC marker detection. Runs unconditionally (no generationType gate)
      // so composer-regen, swipe, and the explicit regenerate path all
      // surface the banner. See detectRegenFeedback() for caveats.
      const detected = detectRegenFeedback(capturedMessages)
      if (detected) {
        snapshot.regenFeedback = detected.text
        snapshot.regenFeedbackRaw = detected.raw
        snapshot.regenFeedbackPosition = detected.position
      }

      store.push(snapshot)
      activeChatId = ctx.chatId ?? activeChatId

      spindle.sendToFrontend({
        type: 'prompt_captured',
        snapshot,
      })
    } catch (err: any) {
      spindle.log.error(`Failed to capture prompt: ${err?.message ?? err}`)
    }

    return messages
  }, 999)

  interceptorRegistered = true
  spindle.log.info('Interceptor registered.')
}

function tryRegisterGenerationEvents(): void {
  if (generationEventsRegistered) return
  if (!spindle.permissions.has('generation')) return

  spindle.on('GENERATION_STARTED', (payload: any) => {
    if (payload.generationId) {
      activeGenerations.set(payload.generationId, {
        chatId: payload.chatId,
        model: payload.model,
        generationType: payload.generationType,
        targetMessageId: payload.targetMessageId,
      })
    }
  })

  spindle.on('GENERATION_ENDED', async (payload: any) => {
    const genId = payload.generationId
    if (genId) {
      activeGenerations.delete(genId)
    }
    if (!payload.chatId || !payload.messageId) return

    try {
      const messages = await spindle.chat.getMessages(payload.chatId)
      const index = messages.findIndex((m: any) => m.id === payload.messageId)
      const msgNum = index !== -1 ? index : undefined
      const msg = index !== -1 ? messages[index] as any : null
      const swipeIndex = typeof msg?.swipe_id === 'number' ? msg.swipe_id : undefined
      store.linkMessage(payload.chatId, payload.messageId, msgNum, genId, swipeIndex)
      const key = swipeKey(payload.chatId, payload.messageId)
      if (key) pendingSwipeAdds.delete(key)

      const updated = store.getAll(payload.chatId).find((s) => s.messageId === payload.messageId)
      if (updated) {
        spindle.sendToFrontend({ type: 'snapshot_updated', snapshot: updated })
      }
    } catch (err: any) {
      store.linkMessage(payload.chatId, payload.messageId, undefined, genId)
    }
  })

  spindle.on('GENERATION_STOPPED', (payload: any) => {
    const genId = payload.generationId
    if (genId) {
      activeGenerations.delete(genId)

      const snap = store.markAborted(genId)
      if (snap) {
        spindle.sendToFrontend({ type: 'snapshot_updated', snapshot: snap })
      }
    }
  })

  generationEventsRegistered = true
  spindle.log.info('Generation event listeners registered.')
}

// ---- Register immediately if permissions are already granted ----
tryRegisterInterceptor()
tryRegisterGenerationEvents()

// ---- React to live permission changes ----
spindle.permissions.onChanged(({ permission, granted }) => {
  if (granted) {
    if (permission === 'interceptor') tryRegisterInterceptor()
    if (permission === 'generation') tryRegisterGenerationEvents()
  }
})

// ---------------------------------------------------------------------------
// Chat tracking (free tier — no permission needed)
// ---------------------------------------------------------------------------
spindle.on('CHAT_SWITCHED', (payload: any) => {
  const chatId = payload.chatId ?? null
  activeChatId = chatId

  spindle.sendToFrontend({
    type: 'chat_changed',
    chatId,
    snapshots: chatId ? store.getAll(chatId) : [],
  })
})

// ---------------------------------------------------------------------------
// Swipe discrimination (free tier — MESSAGE_SWIPED is a chat lifecycle event)
// ---------------------------------------------------------------------------
spindle.on('MESSAGE_SWIPED', (payload: any) => {
  if (payload.action !== 'added') return
  const chatId = payload.chatId
  if (!chatId) return

  prunePendingSwipes()
  const messageId = payload.message?.id
  const key = swipeKey(chatId, messageId)
  if (key) pendingSwipeAdds.set(key, { swipeIndex: payload.swipeId, timestamp: Date.now() })

  const snap = store.tagAsSwipe(chatId, messageId, payload.swipeId)
  if (snap) {
    spindle.sendToFrontend({ type: 'snapshot_updated', snapshot: snap })
  }
})

// ---------------------------------------------------------------------------
// Message lifecycle (free tier)
// ---------------------------------------------------------------------------
spindle.on('MESSAGE_DELETED', async (payload: any) => {
  const chatId = payload.chatId || activeChatId
  if (!chatId) return

  let removed = 0

  if (payload.messageId) {
    removed += store.deleteByMessageId(payload.messageId)
  }

  if (removed === 0 && payload.messageId) {
    try {
      const currentMessages = await spindle.chat.getMessages(chatId)
      const currentIds = new Set(currentMessages.map((m: any) => m.id))
      const snapshots = store.getAll(chatId)
      for (const snap of snapshots) {
        if (snap.messageId && !currentIds.has(snap.messageId)) {
          store.deleteByMessageId(snap.messageId)
          removed++
        }
      }
    } catch {
      // Can't verify — skip
    }
  }

  spindle.sendToFrontend({
    type: 'prompt_history',
    snapshots: store.getAll(chatId),
  })
})

// ---------------------------------------------------------------------------
// Frontend message handler (free tier)
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: any, userId: string) => {
  currentUserId = userId
  const chatId = payload.chatId || activeChatId
  switch (payload.type) {
    case 'get_latest':
      spindle.sendToFrontend({
        type: 'prompt_data',
        snapshot: store.getLatest(chatId),
      })
      break

    case 'get_history':
      spindle.sendToFrontend({
        type: 'prompt_history',
        snapshots: store.getAll(chatId),
      })
      break

    case 'get_by_id':
      spindle.sendToFrontend({
        type: 'prompt_data',
        snapshot: store.getById(payload.id),
      })
      break

    case 'clear_history':
      store.clearChat(chatId)
      spindle.sendToFrontend({ type: 'history_cleared' })
      break

    case 'get_settings': {
      const settings = await loadSettings()
      spindle.sendToFrontend({ type: 'settings_loaded', settings })
      break
    }

    case 'save_settings':
      try {
        await saveSettings(payload.settings)
      } catch (err: any) {
        spindle.toast.error(`Failed to save settings: ${err?.message ?? err}`)
      }
      break
  }
})

spindle.log.info('Prompt Viewer backend loaded.')
