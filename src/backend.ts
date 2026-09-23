// =============================================================================
// prompt-viewer — Backend (Bun worker)
// =============================================================================

import { PromptStore } from './storage/prompt-store'
import type { PromptSnapshot, LlmMessage, InterceptorMeta, TokenCountSource, AutoDryRunEvidence, LikelyAutoDryRunReason } from './storage/prompt-store'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

interface UserState {
  store: PromptStore
  activeChatId: string | null
  activeGenerations: Map<string, ActiveGenerationMeta>
  pendingSwipeAdds: Map<string, { swipeIndex?: number; timestamp: number }>
  pendingAutoDryRunEvidence: Map<string, PendingAutoDryRunEvidence>
  connectionInfoCache: Map<string, { provider?: string; model?: string }>
}

const userStates = new Map<string, UserState>()

function stateFor(userId: string): UserState {
  let state = userStates.get(userId)
  if (!state) {
    state = {
      store: new PromptStore(),
      activeChatId: null,
      activeGenerations: new Map(),
      pendingSwipeAdds: new Map(),
      pendingAutoDryRunEvidence: new Map(),
      connectionInfoCache: new Map(),
    }
    userStates.set(userId, state)
  }
  return state
}

function sendToUser(userId: string, payload: unknown, frontendSessionId?: string): void {
  // Staging supports session-scoped delivery; the published types only declare
  // the two-argument form so use the host's runtime signature here.
  (spindle as any).sendToFrontend(payload, userId, frontendSessionId ? { frontendSessionId } : undefined)
}

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

async function loadSettings(userId: string): Promise<Settings> {
  try {
    const saved = await spindle.userStorage.getJson<Partial<Settings>>('settings.json', {
      fallback: {},
      userId,
    })
    const settings = { ...DEFAULT_SETTINGS, ...saved }
    stateFor(userId).store.setMaxPerChat(settings.maxHistoryPerChat)
    return settings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

async function saveSettings(settings: Settings, userId: string): Promise<void> {
  await spindle.userStorage.setJson('settings.json', settings, {
    indent: 2,
    userId,
  })
  stateFor(userId).store.setMaxPerChat(settings.maxHistoryPerChat)
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

// ---------------------------------------------------------------------------
// Stage 2: "include previous generation" wrapper.
//
// When the regen modal's checkbox is on, the client composes the feedback as:
//   `[REJECTED MESSAGE: <preamble> Previous message for reference: {{regeneratedMessage}}]\n\n<feedback>`
// The `{{regeneratedMessage}}` macro is resolved by the host's late macro pass
// (resolvePromptMacrosAfterRegexPass), so by interceptor time the OOC body is:
//   `[REJECTED MESSAGE: … reference: <full rejected message>]\n\n<feedback>`
//
// Split rules:
//   - Anchor on the literal `[REJECTED MESSAGE:` prefix and the literal
//     `Previous message for reference:` marker (both compile-time constants in
//     Lumiverse's RegenFeedbackModal).
//   - GREEDY message capture, then backtrack to the LAST `]` + newline(s)
//     before the trailing feedback. A rejected RP message routinely contains
//     `]` + blank lines (bracketed OOC asides, paragraph breaks); the user's
//     short feedback text rarely does. Greedy therefore mis-splits only when
//     the FEEDBACK itself contains `]` followed by a newline — accepted risk.
//   - On any parse failure, fall back to stage-1 behavior (whole body treated
//     as feedback), i.e. worst case is exactly the pre-1.0.8 result.
// ---------------------------------------------------------------------------
const REJECTED_PREFIX = '[REJECTED MESSAGE:'
const REJECTED_SPLIT_RE = /^\[REJECTED MESSAGE:[\s\S]*?Previous message for reference:\s*([\s\S]*)\]\s*\n+([\s\S]*)$/
const REJECTED_NO_FEEDBACK_RE = /^\[REJECTED MESSAGE:[\s\S]*?Previous message for reference:\s*([\s\S]*)\]\s*$/

function splitRejectedWrapper(body: string): { rejectedMessage: string; feedback: string } | null {
  if (!body.startsWith(REJECTED_PREFIX)) return null
  let m = REJECTED_SPLIT_RE.exec(body)
  if (m) return { rejectedMessage: m[1].trim(), feedback: m[2].trim() }
  m = REJECTED_NO_FEEDBACK_RE.exec(body)
  if (m) return { rejectedMessage: m[1].trim(), feedback: '' }
  return null
}

interface RegenFeedbackDetection {
  /** Feedback text only. For plain OOCs this is the whole inner body; for the
   *  rejected-message wrapper it is just the user's trailing feedback. */
  text: string
  /** Raw matched marker including `[OOC: ]` wrapper, exactly as injected. */
  raw: string
  /** Which slot the marker appeared in. Detection-driven, not user-setting-driven. */
  position: 'system' | 'user'
  /** Rejected previous message extracted from the wrapper, when present. */
  rejectedMessage?: string
}

function buildDetection(m: RegExpExecArray, position: 'system' | 'user'): RegenFeedbackDetection {
  const body = m[2].trim()
  const split = splitRejectedWrapper(body)
  if (split) {
    return { text: split.feedback, raw: m[1], position, rejectedMessage: split.rejectedMessage }
  }
  return { text: body, raw: m[1], position }
}

function detectRegenFeedback(messages: LlmMessage[]): RegenFeedbackDetection | null {
  if (!messages.length) return null

  // Staging's interceptor bridge stamps `__isChatHistory` onto real chat
  // turns — the same identity marker the assembler's regen-feedback injector
  // uses to pick its target message. When flags are present anywhere in the
  // array, use them: block-based assembly appends preset user/system blocks
  // (turn-format blocks, group nudge, sendIfEmpty, empty-send nudge) AFTER
  // the injection point, so the marker-bearing message is no longer the last
  // user message. When no flags exist (older hosts), fall back to the 1.0.7
  // walk, which stops at the first trailing user message without a marker.
  const hasHistoryFlags = messages.some((m) => (m as unknown as Record<string, unknown>).__isChatHistory === true)

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const candidates = messageTextCandidates(msg.content)
    if (candidates.length === 0) continue

    if (msg.role === 'system') {
      for (const content of candidates) {
        const m = SYSTEM_OOC_RE.exec(content)
        if (m) return buildDetection(m, 'system')
      }
      // A system message that ISN'T a pure OOC marker is fine — keep walking.
      // The assembler can leave other system messages at the tail (e.g.
      // depth-injected blocks, continue nudge), so non-match here is not a
      // stop condition.
      continue
    }

    if (msg.role === 'user') {
      for (const content of candidates) {
        const m = TRAILING_USER_OOC_RE.exec(content) || SYSTEM_OOC_RE.exec(content)
        if (m) return buildDetection(m, 'user')
      }
      if (!hasHistoryFlags) {
        // Legacy hosts: tail user message without the marker — feedback
        // wasn't injected in 'user' position. Stop; looking further back
        // would risk picking up older OOC text from earlier turns.
        return null
      }
      if ((msg as unknown as Record<string, unknown>).__isChatHistory === true) {
        // The real latest chat turn, and it carries no marker: no feedback.
        return null
      }
      // Unflagged user message = preset block / nudge appended after the
      // injection point — keep walking toward the actual chat history.
      continue
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
// Connection profile lookup — provider/model fallback for snapshots that never
// receive a GENERATION_BREAKDOWN_READY event (dry runs). The connections API
// is gated behind the `generation` permission, which the manifest declares.
// Typed loosely because lumiverse-spindle-types may predate the API.
// ---------------------------------------------------------------------------
async function resolveConnectionInfo(
  connectionId: unknown,
  userId: string,
): Promise<{ provider?: string; model?: string } | null> {
  if (typeof connectionId !== 'string' || !connectionId) return null
  const cache = stateFor(userId).connectionInfoCache
  const cached = cache.get(connectionId)
  if (cached) return cached
  try {
    const api = (spindle as any).connections
    if (!api?.get) return null
    const conn = await api.get(connectionId, userId)
    const info = {
      provider: typeof conn?.provider === 'string' && conn.provider ? conn.provider : undefined,
      model: typeof conn?.model === 'string' && conn.model ? conn.model : undefined,
    }
    if (cache.size > 50) cache.clear()
    cache.set(connectionId, info)
    return info
  } catch {
    return null
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
  targetSwipeId?: number
}

function swipeKey(chatId?: string, messageId?: string): string | null {
  return chatId && messageId ? `${chatId}:${messageId}` : null
}

function getActiveGenerationForChat(state: UserState, chatId?: string): { generationId: string; meta: ActiveGenerationMeta } | null {
  // When the interceptor identifies its chat, require an exact match. Falling
  // back to an unrelated sole active generation can misclassify a dry run in
  // another chat as live and attach the wrong generation metadata.
  if (chatId) {
    const matches = [...state.activeGenerations].filter(([, meta]) => meta.chatId === chatId)
    // The interceptor context has no generationId. Never guess between two
    // concurrent live generations in the same chat.
    return matches.length === 1 ? { generationId: matches[0][0], meta: matches[0][1] } : null
  }

  // Older hosts or unusual system prompts may omit chatId. Preserve the
  // previous single-generation fallback only for that genuinely ambiguous case.
  if (state.activeGenerations.size !== 1) return null
  const [generationId, meta] = state.activeGenerations.entries().next().value as [string, ActiveGenerationMeta]
  return { generationId, meta }
}

function prunePendingSwipes(state: UserState, now = Date.now()): void {
  for (const [key, value] of state.pendingSwipeAdds) {
    if (now - value.timestamp > 5 * 60 * 1000) state.pendingSwipeAdds.delete(key)
  }
}

/**
 * structuredClone that degrades gracefully: if the whole object can't be
 * cloned (e.g. the host adds an AbortSignal, function, or other
 * non-cloneable value to the interceptor context), fall back to cloning
 * property-by-property and silently dropping the offending entries instead
 * of failing the entire prompt capture.
 */
function cloneSafe<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        try {
          out[k] = structuredClone(v)
        } catch {
          // non-cloneable value — drop it from the snapshot
        }
      }
      return out as T
    }
    // Last resort for arrays/exotic roots: JSON round-trip
    return JSON.parse(JSON.stringify(value)) as T
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
      const ctx = context as unknown as InterceptorMeta

      // Lumiverse staging attaches a per-run AbortSignal to the interceptor
      // context (for intercept_abort support). AbortSignal is not
      // structured-cloneable, so strip it — and defensively drop any other
      // non-cloneable values the host may add later — before snapshotting.
      const { signal: _signal, ...cloneableCtx } =
        ctx as InterceptorMeta & { signal?: AbortSignal }

      // ONLY the clones must happen synchronously: later pipeline stages
      // (applyPostProcessing, other interceptors) mutate the message array in
      // place, so we must copy before returning. Everything below operates on
      // our private copies and is deferred off the generation's critical path.
      const capturedMessages = structuredClone(messages) as LlmMessage[]
      const ctxSnapshot = cloneSafe(cloneableCtx) as InterceptorMeta

      // Never place an unidentified capture in a shared operator worker.
      const ctxUserId = typeof ctxSnapshot.userId === 'string' && ctxSnapshot.userId
        ? ctxSnapshot.userId
        : undefined
      if (!ctxUserId) {
        spindle.log.warn('Prompt Viewer skipped a capture without a userId in interceptor context.')
        return messages
      }
      const state = stateFor(ctxUserId)

      // queueMicrotask (NOT setTimeout): microtasks drain before the worker
      // can process any subsequent host postMessage, so activeGenerations and
      // pendingSwipeAdds are read in exactly the state a synchronous read
      // would have seen — a later GENERATION_ENDED cannot sneak in between.
      queueMicrotask(() => {
        try {
          const snapshot: PromptSnapshot = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            messages: capturedMessages,
            context: ctxSnapshot,
            estimatedTokens: estimateTokensFallback(capturedMessages),
            tokenCountSource: 'fallback',
            approximateTokens: true,
          }

          // Staging provides an authoritative dryRun boolean in interceptor
          // context. Trust it when present; only infer from generation events
          // for compatibility with older hosts that do not provide the flag.
          // A confirmed dry run must never inherit metadata from a coincident
          // live generation, even if one exists for the same chat.
          const contextDryRun = typeof ctxSnapshot.dryRun === 'boolean'
            ? ctxSnapshot.dryRun
            : undefined
          const active = contextDryRun === true
            ? null
            : getActiveGenerationForChat(state, ctxSnapshot.chatId)
          snapshot.isDryRun = contextDryRun ?? !active
          if (snapshot.isDryRun && typeof ctxSnapshot.chatId === 'string') {
            const evidence = consumeAutoDryRunEvidence(state, ctxSnapshot.chatId, Date.now())
            if (evidence) {
              snapshot.isLikelyAutoDryRun = true
              snapshot.autoDryRunEvidence = evidence
            }
          }
          if (active) {
            snapshot.generationId = active.generationId
            if (active.meta.model) snapshot.model = active.meta.model

            const key = swipeKey(ctxSnapshot.chatId, active.meta.targetMessageId)
            const pendingSwipe = key ? state.pendingSwipeAdds.get(key) : null
            if ((pendingSwipe && (active.meta.targetSwipeId === undefined || pendingSwipe.swipeIndex === active.meta.targetSwipeId))
              || active.meta.generationType === 'swipe') {
              snapshot.isSwipe = true
              snapshot.swipeIndex = active.meta.targetSwipeId ?? pendingSwipe?.swipeIndex
            }
          }

          // Async token count — fire and forget, update snapshot when ready
          countTokens(capturedMessages, snapshot.model, ctxUserId).then((result) => {
            snapshot.estimatedTokens = result.tokens
            snapshot.approximateTokens = result.approximate
            snapshot.tokenCountSource = result.source
            if (result.tokenizer) snapshot.tokenizer = result.tokenizer
            if (result.tokenModel) snapshot.tokenModel = result.tokenModel
            if (result.tokenModelSource) snapshot.tokenModelSource = result.tokenModelSource
            if (result.error) snapshot.tokenizerError = result.error
            sendToUser(ctxUserId, { type: 'snapshot_updated', snapshot })
          })

          // Provider fallback — GENERATION_BREAKDOWN_READY fills provider for
          // live generations, but never fires for dry runs. Resolve it from
          // the connection profile (cached) so dry-run snapshots aren't bare.
          resolveConnectionInfo(ctxSnapshot.connectionId, ctxUserId).then((info) => {
            if (!info) return
            let changed = false
            if (!snapshot.provider && info.provider) { snapshot.provider = info.provider; changed = true }
            if (!snapshot.model && info.model) { snapshot.model = info.model; changed = true }
            if (changed) sendToUser(ctxUserId, { type: 'snapshot_updated', snapshot })
          })

          // OOC marker detection. Runs unconditionally (no generationType gate)
          // so composer-regen, swipe, and the explicit regenerate path all
          // surface the banner. See detectRegenFeedback() for caveats.
          const detected = detectRegenFeedback(capturedMessages)
          if (detected) {
            snapshot.regenFeedback = detected.text
            snapshot.regenFeedbackRaw = detected.raw
            snapshot.regenFeedbackPosition = detected.position
            if (detected.rejectedMessage !== undefined) snapshot.rejectedMessage = detected.rejectedMessage
          }

          state.store.push(snapshot)

          sendToUser(ctxUserId, {
            type: 'prompt_captured',
            snapshot,
          })
        } catch (err: any) {
          spindle.log.error(`Failed to capture prompt: ${err?.message ?? err}`)
        }
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

  spindle.on('GENERATION_STARTED', (payload: any, userId?: string) => {
    if (!userId) return
    if (payload.generationId) {
      stateFor(userId).activeGenerations.set(payload.generationId, {
        chatId: payload.chatId,
        model: payload.model,
        generationType: payload.generationType,
        targetMessageId: payload.targetMessageId,
        targetSwipeId: typeof payload.targetSwipeId === 'number' ? payload.targetSwipeId : undefined,
      })
    }
  })

  // Final outbound parameters, provider, preset, and real usage. Emitted by
  // the host's deferred post-processing after a live generation completes
  // (never for dry runs), carrying the same ground-truth data the native
  // Prompt Breakdown renders. Linked to our snapshot by generationId.
  spindle.on('GENERATION_BREAKDOWN_READY', (payload: any, userId?: string) => {
    if (!userId) return
    const b = payload?.breakdown
    if (!payload?.generationId || !b || typeof b !== 'object') return

    const usage = b.usage && typeof b.usage === 'object'
      ? {
          prompt_tokens: typeof b.usage.prompt_tokens === 'number' ? b.usage.prompt_tokens : undefined,
          completion_tokens: typeof b.usage.completion_tokens === 'number' ? b.usage.completion_tokens : undefined,
          total_tokens: typeof b.usage.total_tokens === 'number' ? b.usage.total_tokens : undefined,
        }
      : undefined

    const snap = stateFor(userId).store.attachGenerationInfo(payload.generationId, {
      parameters: b.parameters && typeof b.parameters === 'object' && !Array.isArray(b.parameters)
        ? b.parameters as Record<string, unknown>
        : undefined,
      provider: typeof b.provider === 'string' && b.provider ? b.provider : undefined,
      presetName: typeof b.presetName === 'string' && b.presetName ? b.presetName : undefined,
      usage,
      maxContext: typeof b.maxContext === 'number' && b.maxContext > 0 ? b.maxContext : undefined,
      model: typeof b.model === 'string' && b.model ? b.model : undefined,
    })
    if (snap) {
      sendToUser(userId, { type: 'snapshot_updated', snapshot: snap })
    }
  })

  spindle.on('GENERATION_ENDED', async (payload: any, userId?: string) => {
    if (!userId) return
    const state = stateFor(userId)
    const genId = payload.generationId
    if (genId) {
      state.activeGenerations.delete(genId)
    }
    if (!payload.chatId || !payload.messageId) return

    try {
      const messages = await spindle.chat.getMessages(payload.chatId)
      const index = messages.findIndex((m: any) => m.id === payload.messageId)
      const msgNum = index !== -1 ? index : undefined
      const msg = index !== -1 ? messages[index] as any : null
      const swipeIndex = typeof msg?.swipe_id === 'number' ? msg.swipe_id : undefined
      const updated = state.store.linkMessage(payload.chatId, payload.messageId, msgNum, genId, swipeIndex)
      const key = swipeKey(payload.chatId, payload.messageId)
      if (key) state.pendingSwipeAdds.delete(key)

      if (updated) {
        sendToUser(userId, { type: 'snapshot_updated', snapshot: updated })
      }
    } catch (err: any) {
      const updated = state.store.linkMessage(payload.chatId, payload.messageId, undefined, genId)
      if (updated) sendToUser(userId, { type: 'snapshot_updated', snapshot: updated })
    }
  })

  spindle.on('GENERATION_STOPPED', (payload: any, userId?: string) => {
    if (!userId) return
    const state = stateFor(userId)
    const genId = payload.generationId
    if (genId) {
      state.activeGenerations.delete(genId)

      const snap = state.store.markAborted(genId)
      if (snap) {
        sendToUser(userId, { type: 'snapshot_updated', snapshot: snap })
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
// Automatic Dry Run heuristics. Lumiverse authoritatively identifies Dry Runs,
// but does not expose who requested one. Prompt Viewer therefore keeps a
// single, one-shot lifecycle evidence record per chat and labels a subsequent
// Dry Run as *likely* automatic when it arrives within the relevant window.
const CHAT_ENTRY_DRY_RUN_WINDOW_MS = 4000
const REGEN_MUTATION_DRY_RUN_WINDOW_MS = 10_000

interface PendingAutoDryRunEvidence {
  reason: LikelyAutoDryRunReason
  timestamp: number
  messageId?: string
}

function evidenceWindowMs(reason: LikelyAutoDryRunReason): number {
  return reason === 'chat-entry'
    ? CHAT_ENTRY_DRY_RUN_WINDOW_MS
    : REGEN_MUTATION_DRY_RUN_WINDOW_MS
}

function prunePendingAutoDryRunEvidence(state: UserState, now = Date.now()): void {
  for (const [chatId, evidence] of state.pendingAutoDryRunEvidence) {
    if (now - evidence.timestamp >= evidenceWindowMs(evidence.reason)) {
      state.pendingAutoDryRunEvidence.delete(chatId)
    }
  }
}

function markPendingAutoDryRunEvidence(
  state: UserState,
  chatId: string,
  reason: LikelyAutoDryRunReason,
  options: { now?: number; messageId?: string } = {},
): void {
  const now = options.now ?? Date.now()
  prunePendingAutoDryRunEvidence(state, now)
  state.pendingAutoDryRunEvidence.set(chatId, {
    reason,
    timestamp: now,
    messageId: options.messageId,
  })
}

function consumeAutoDryRunEvidence(state: UserState, chatId: string, now: number): AutoDryRunEvidence | undefined {
  const evidence = state.pendingAutoDryRunEvidence.get(chatId)
  if (!evidence) return undefined

  // Always consume once. An expired or coincidental marker must not tag a
  // later Dry Run merely because no earlier capture used it.
  state.pendingAutoDryRunEvidence.delete(chatId)

  const ageMs = Math.max(0, now - evidence.timestamp)
  if (ageMs >= evidenceWindowMs(evidence.reason)) return undefined

  return {
    reason: evidence.reason,
    observedAt: evidence.timestamp,
    ageMs,
    messageId: evidence.messageId,
  }
}

/**
 * MESSAGE_DELETED only exposes IDs, not the deleted role or the user's action.
 * When PV has a linked live-generation capture, require the deletion to match
 * the latest such message. If linkage is unavailable, preserve compatibility
 * and allow the short-lived heuristic rather than silently missing regens.
 */
function isLikelyRegenerationDeletion(state: UserState, chatId: string, messageId?: string): boolean {
  if (!messageId) return false
  const latestLinkedLive = state.store.getAll(chatId)
    .find((snapshot) => !snapshot.isDryRun && typeof snapshot.messageId === 'string')
  return latestLinkedLive ? latestLinkedLive.messageId === messageId : true
}

spindle.on('CHAT_SWITCHED', (payload: any, userId?: string) => {
  if (!userId) return
  const state = stateFor(userId)
  const chatId = payload.chatId ?? null
  state.activeChatId = chatId
  if (chatId) {
    markPendingAutoDryRunEvidence(state, chatId, 'chat-entry')
  }

  sendToUser(userId, {
    type: 'chat_changed',
    chatId,
    snapshots: chatId ? state.store.getAll(chatId) : [],
  })
})

// ---------------------------------------------------------------------------
// Swipe discrimination (free tier — MESSAGE_SWIPED is a chat lifecycle event)
// ---------------------------------------------------------------------------
spindle.on('MESSAGE_SWIPED', (payload: any, userId?: string) => {
  if (!userId) return
  const state = stateFor(userId)
  if (payload.action !== 'added') return
  const chatId = payload.chatId
  if (!chatId) return

  // Lumiverse stages regenerate/swipe generations by adding a blank swipe
  // before prompt assembly. Some extensions react to that mutation by issuing
  // their own Dry Run. Record a one-shot marker so only the next Dry Run for
  // this chat can be tagged as automatic.
  const addedSwipe = Array.isArray(payload.message?.swipes)
    ? payload.message.swipes[payload.swipeId]
    : undefined
  if (addedSwipe === '' || payload.message?.content === '') {
    markPendingAutoDryRunEvidence(state, chatId, 'regen-mutation', {
      messageId: typeof payload.message?.id === 'string' ? payload.message.id : undefined,
    })
  }

  prunePendingSwipes(state)
  const messageId = payload.message?.id
  const key = swipeKey(chatId, messageId)
  if (key) state.pendingSwipeAdds.set(key, { swipeIndex: payload.swipeId, timestamp: Date.now() })
})

// ---------------------------------------------------------------------------
// Message lifecycle (free tier)
// ---------------------------------------------------------------------------
spindle.on('MESSAGE_DELETED', async (payload: any, userId?: string) => {
  if (!userId) return
  const state = stateFor(userId)
  const chatId = payload.chatId || state.activeChatId
  if (!chatId) return

  // Composer Regenerate deletes the prior assistant message before prompt
  // assembly. Treat that as one-shot evidence only when it matches PV's latest
  // linked live generation (or when linkage is unavailable and cannot be
  // checked). Deleting an older captured message will not tag the next Dry Run.
  const deletedMessageId = typeof payload.messageId === 'string'
    ? payload.messageId
    : undefined
  if (isLikelyRegenerationDeletion(state, chatId, deletedMessageId)) {
    markPendingAutoDryRunEvidence(state, chatId, 'regen-mutation', {
      messageId: deletedMessageId,
    })
  }

  let removed = 0

  if (payload.messageId) {
    removed += state.store.deleteByMessageId(payload.messageId)
  }

  if (removed === 0 && payload.messageId) {
    try {
      const currentMessages = await spindle.chat.getMessages(chatId)
      const currentIds = new Set(currentMessages.map((m: any) => m.id))
      const snapshots = state.store.getAll(chatId)
      for (const snap of snapshots) {
        if (snap.messageId && !currentIds.has(snap.messageId)) {
          state.store.deleteByMessageId(snap.messageId)
          removed++
        }
      }
    } catch {
      // Can't verify — skip
    }
  }

  sendToUser(userId, {
    type: 'prompt_history',
    snapshots: state.store.getAll(chatId),
  })
})

// ---------------------------------------------------------------------------
// Frontend message handler (free tier)
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: any, userId: string, frontendSessionId?: string) => {
  const state = stateFor(userId)
  const chatId = payload.chatId || state.activeChatId
  switch (payload.type) {
    case 'get_latest':
      sendToUser(userId, {
        type: 'prompt_data',
        snapshot: state.store.getLatest(chatId),
      }, frontendSessionId)
      break

    case 'get_history':
      sendToUser(userId, {
        type: 'prompt_history',
        snapshots: state.store.getAll(chatId),
      }, frontendSessionId)
      break

    case 'get_by_id':
      sendToUser(userId, {
        type: 'prompt_data',
        snapshot: state.store.getById(payload.id),
      }, frontendSessionId)
      break

    case 'clear_history':
      state.store.clearChat(chatId)
      sendToUser(userId, { type: 'history_cleared' }, frontendSessionId)
      break

    case 'get_settings': {
      const settings = await loadSettings(userId)
      sendToUser(userId, { type: 'settings_loaded', settings }, frontendSessionId)
      break
    }

    case 'save_settings':
      try {
        await saveSettings(payload.settings, userId)
      } catch (err: any) {
        spindle.toast.error(`Failed to save settings: ${err?.message ?? err}`)
      }
      break
  }
})

spindle.log.info('Prompt Viewer backend loaded.')
