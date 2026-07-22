// =============================================================================
// Prompt snapshot store
// =============================================================================

export type LlmMessagePartDTO =
  | { type: 'text'; text: string }
  | { type: 'image'; data?: string; mime_type?: string }
  | { type: 'audio'; data?: string; mime_type?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmMessagePartDTO[]
  name?: string
}

export type TokenCountSource = 'native' | 'native_approximate' | 'fallback'

export type AutoDryRunReason = 'chat-entry' | 'regen-mutation'

export interface InterceptorMeta {
  chatId?: string
  connectionId?: string
  personaId?: string
  generationType?: string
  /** Authoritative host flag on staging; absent on older Lumiverse versions. */
  dryRun?: boolean
  activatedWorldInfo?: unknown[]
  [key: string]: unknown
}

export interface PromptSnapshot {
  id: string
  timestamp: number
  messages: LlmMessage[]
  context: InterceptorMeta
  estimatedTokens: number
  generationId?: string
  messageId?: string
  messageNumber?: number
  isDryRun?: boolean
  /** Heuristic: dry run captured immediately after a chat switch or the blank
   *  swipe mutation Lumiverse uses to stage a regeneration. The host does not
   *  expose which extension requested a dry run, so this remains inference.
   *  Tagged, never dropped; the frontend hides these behind a setting. */
  isAutoDryRun?: boolean
  autoDryRunReason?: AutoDryRunReason
  model?: string
  /** OOC feedback text extracted from a regen-with-feedback generation
   *  (inner text only, no `[OOC: ]` wrapping). Used for clipboard / programmatic access. */
  regenFeedback?: string
  /** Raw matched marker including the `[OOC: ]` wrapper, exactly as it appeared
   *  in the assembled messages. Used for inline display so the banner mirrors
   *  what's actually in the prompt. */
  regenFeedbackRaw?: string
  /** Where the OOC was injected: 'system' (own message) or 'user' (appended to last user msg) */
  regenFeedbackPosition?: 'system' | 'user'
  /** When the regen modal's "include previous generation" option was on, the
   *  rejected message text extracted from the `[REJECTED MESSAGE: ...]` wrapper.
   *  When set, `regenFeedback` holds only the user's actual feedback text. */
  rejectedMessage?: string
  /** Final outbound generation parameters — ground truth from the host's
   *  GENERATION_BREAKDOWN_READY event (post-merge, internals stripped). */
  parameters?: Record<string, unknown>
  /** Provider name. From GENERATION_BREAKDOWN_READY for live generations, or
   *  the connection profile as a fallback (e.g. dry runs, which emit no breakdown). */
  provider?: string
  /** Preset used for the generation, from GENERATION_BREAKDOWN_READY. */
  presetName?: string
  /** Provider-reported real token usage, from GENERATION_BREAKDOWN_READY. */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  /** Connection max context, from GENERATION_BREAKDOWN_READY. */
  maxContext?: number
  /** True if this generation was a swipe (distinguished from plain regen via MESSAGE_SWIPED) */
  isSwipe?: boolean
  /** The swipe index that was added, if applicable */
  swipeIndex?: number
  /** True if the generation was aborted/stopped but partial content was saved */
  wasAborted?: boolean
  /** True if token count is approximate rather than a model tokenizer count. */
  approximateTokens?: boolean
  /** Where the token count came from. */
  tokenCountSource?: TokenCountSource
  /** Model resolved/used for token counting, if available. */
  tokenModel?: string
  /** Resolution source reported by Lumiverse token counting. */
  tokenModelSource?: 'main' | 'sidecar' | 'explicit'
  /** Name of the tokenizer used for the count, if available */
  tokenizer?: string
  /** Native-tokenizer error that caused Prompt Viewer to use fallback, if any. */
  tokenizerError?: string
}

export class PromptStore {
  private chats = new Map<string, PromptSnapshot[]>()
  private all: PromptSnapshot[] = []
  private maxPerChat = 50
  private maxGlobal = 500

  setMaxPerChat(max: number): void {
    this.maxPerChat = Math.max(1, Math.min(500, max))
    this.maxGlobal = Math.max(100, this.maxPerChat * 10)
    for (const [chatId, arr] of this.chats.entries()) {
      if (arr.length > this.maxPerChat) this.chats.set(chatId, arr.slice(arr.length - this.maxPerChat))
    }
    if (this.all.length > this.maxGlobal) this.all = this.all.slice(this.all.length - this.maxGlobal)
  }

  private getChat(chatId: string): PromptSnapshot[] {
    let arr = this.chats.get(chatId)
    if (!arr) {
      arr = []
      this.chats.set(chatId, arr)
    }
    return arr
  }

  push(snap: PromptSnapshot): void {
    this.all.push(snap)
    if (this.all.length > this.maxGlobal) this.all.shift()

    const chatId = snap.context.chatId
    if (chatId) {
      const arr = this.getChat(chatId)
      arr.push(snap)
      if (arr.length > this.maxPerChat) arr.shift()
    }
  }

  getLatest(chatId?: string): PromptSnapshot | null {
    return this.getAll(chatId)[0] ?? null
  }

  getAll(chatId?: string): PromptSnapshot[] {
    const arr = chatId ? this.getChat(chatId) : this.all
    return [...arr].reverse()
  }

  getById(id: string): PromptSnapshot | null {
    return this.all.find((s) => s.id === id) ?? null
  }

  private replaceSnapshot(updated: PromptSnapshot): void {
    const ai = this.all.findIndex((s) => s.id === updated.id)
    if (ai !== -1) this.all[ai] = updated
    const chatId = updated.context.chatId
    if (chatId) {
      const arr = this.getChat(chatId)
      const ci = arr.findIndex((s) => s.id === updated.id)
      if (ci !== -1) arr[ci] = updated
    }
  }

  /** Merge late-arriving generation info (parameters, provider, usage, …) into
   *  the snapshot captured for `generationId`. Skips undefined fields so a
   *  sparse payload can never clobber already-captured values. */
  attachGenerationInfo(generationId: string, fields: Partial<PromptSnapshot>): PromptSnapshot | null {
    if (!generationId) return null
    for (let i = this.all.length - 1; i >= 0; i--) {
      const snap = this.all[i]
      if (snap.generationId !== generationId) continue
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) (snap as unknown as Record<string, unknown>)[key] = value
      }
      this.replaceSnapshot(snap)
      return snap
    }
    return null
  }

  linkMessage(chatId: string, messageId: string, messageNumber?: number, generationId?: string, swipeIndex?: number): void {
    const arr = this.getChat(chatId)
    if (generationId) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].generationId === generationId) {
          arr[i].messageId = messageId
          if (messageNumber !== undefined) arr[i].messageNumber = messageNumber
          if (swipeIndex !== undefined && arr[i].isSwipe) arr[i].swipeIndex = swipeIndex
          this.replaceSnapshot(arr[i])
          return
        }
      }
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!arr[i].messageId) {
        arr[i].messageId = messageId
        if (messageNumber !== undefined) arr[i].messageNumber = messageNumber
        if (swipeIndex !== undefined && arr[i].isSwipe) arr[i].swipeIndex = swipeIndex
        this.replaceSnapshot(arr[i])
        return
      }
    }
  }

  deleteByMessageId(messageId: string): number {
    let removed = 0
    const beforeAll = this.all.length
    this.all = this.all.filter((s) => s.messageId !== messageId)
    removed += beforeAll - this.all.length
    for (const [chatId, arr] of this.chats.entries()) {
      const before = arr.length
      const filtered = arr.filter((s) => s.messageId !== messageId)
      if (filtered.length < before) this.chats.set(chatId, filtered)
    }
    return removed
  }

  clearChat(chatId?: string): void {
    if (!chatId) {
      this.all = []
      this.chats.clear()
      return
    }
    this.all = this.all.filter((s) => s.context.chatId !== chatId)
    this.chats.set(chatId, [])
  }

  /** Tag a snapshot as a swipe by messageId, falling back to most recent regen */
  tagAsSwipe(chatId: string, messageId?: string, swipeIndex?: number): PromptSnapshot | null {
    const arr = this.getChat(chatId)
    if (messageId) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].messageId === messageId) {
          arr[i].isSwipe = true
          if (swipeIndex !== undefined) arr[i].swipeIndex = swipeIndex
          this.replaceSnapshot(arr[i])
          return arr[i]
        }
      }
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      const snap = arr[i]
      if (!snap.isSwipe && (snap.context.generationType === 'regenerate' || snap.context.generationType === 'swipe')) {
        snap.isSwipe = true
        if (swipeIndex !== undefined) snap.swipeIndex = swipeIndex
        this.replaceSnapshot(snap)
        return snap
      }
    }
    return null
  }

  /** Mark a snapshot as aborted by generationId */
  markAborted(generationId: string): PromptSnapshot | null {
    for (const snap of [...this.all].reverse()) {
      if (snap.generationId === generationId) {
        snap.wasAborted = true
        this.replaceSnapshot(snap)
        return snap
      }
    }
    return null
  }
}
