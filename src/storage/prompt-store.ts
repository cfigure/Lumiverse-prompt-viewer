// =============================================================================
// Per-chat ring buffer for prompt snapshots
// =============================================================================

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

export interface InterceptorMeta {
  chatId: string
  connectionId: string
  personaId: string
  generationType: string
  activatedWorldInfo: unknown[]
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
  /** True if this generation was a swipe (distinguished from plain regen via MESSAGE_SWIPED) */
  isSwipe?: boolean
  /** The swipe index that was added, if applicable */
  swipeIndex?: number
  /** True if the generation was aborted/stopped but partial content was saved */
  wasAborted?: boolean
  /** True if token count is a chars/4 estimate rather than proper tokenizer count */
  approximateTokens?: boolean
  /** Name of the tokenizer used for the count, if available */
  tokenizer?: string
}

export class PromptStore {
  private chats = new Map<string, PromptSnapshot[]>()
  private maxPerChat = 50

  setMaxPerChat(max: number): void {
    this.maxPerChat = Math.max(1, Math.min(500, max))
    // Trim existing chats if needed
    for (const [chatId, arr] of this.chats.entries()) {
      if (arr.length > this.maxPerChat) {
        this.chats.set(chatId, arr.slice(arr.length - this.maxPerChat))
      }
    }
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
    const arr = this.getChat(snap.context.chatId)
    arr.push(snap)
    if (arr.length > this.maxPerChat) arr.shift()
  }

  getLatest(chatId: string): PromptSnapshot | null {
    return this.getChat(chatId).at(-1) ?? null
  }

  getAll(chatId: string): PromptSnapshot[] {
    return [...this.getChat(chatId)].reverse()
  }

  getById(id: string): PromptSnapshot | null {
    for (const arr of this.chats.values()) {
      const found = arr.find((s) => s.id === id)
      if (found) return found
    }
    return null
  }

  linkMessage(chatId: string, messageId: string, messageNumber?: number, generationId?: string): void {
    const arr = this.getChat(chatId)
    // Prefer linking by generationId for reliability
    if (generationId) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].generationId === generationId) {
          arr[i].messageId = messageId
          if (messageNumber !== undefined) arr[i].messageNumber = messageNumber
          return
        }
      }
    }
    // Fallback: find the most recent unlinked snapshot
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!arr[i].messageId) {
        arr[i].messageId = messageId
        if (messageNumber !== undefined) arr[i].messageNumber = messageNumber
        return
      }
    }
  }

  deleteByMessageId(messageId: string): number {
    let removed = 0
    for (const [chatId, arr] of this.chats.entries()) {
      const before = arr.length
      const filtered = arr.filter((s) => s.messageId !== messageId)
      if (filtered.length < before) {
        removed += before - filtered.length
        this.chats.set(chatId, filtered)
      }
    }
    return removed
  }

  clearChat(chatId: string): void {
    this.chats.delete(chatId)
  }

  /** Tag a snapshot as a swipe by messageId, falling back to most recent regen */
  tagAsSwipe(chatId: string, messageId?: string, swipeIndex?: number): PromptSnapshot | null {
    const arr = this.getChat(chatId)

    // Prefer matching by messageId — reliable when GENERATION_ENDED has already linked
    if (messageId) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].messageId === messageId) {
          arr[i].isSwipe = true
          if (swipeIndex !== undefined) arr[i].swipeIndex = swipeIndex
          return arr[i]
        }
      }
    }

    // Fallback: tag the most recent untagged regen snapshot
    for (let i = arr.length - 1; i >= 0; i--) {
      const snap = arr[i]
      if (!snap.isSwipe && (snap.context.generationType === 'regenerate' || snap.context.generationType === 'swipe')) {
        snap.isSwipe = true
        if (swipeIndex !== undefined) snap.swipeIndex = swipeIndex
        return snap
      }
    }
    return null
  }

  /** Mark a snapshot as aborted by generationId */
  markAborted(generationId: string): PromptSnapshot | null {
    for (const arr of this.chats.values()) {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].generationId === generationId) {
          arr[i].wasAborted = true
          return arr[i]
        }
      }
    }
    return null
  }
}
