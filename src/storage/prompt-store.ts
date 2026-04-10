// =============================================================================
// Ring buffer holding the last N captured prompt snapshots, keyed by chatId.
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
  /** The messageId produced by this generation (set after GENERATION_ENDED). */
  messageId?: string
  /** The chat message number (e.g. #4) — set after GENERATION_ENDED. */
  messageNumber?: number
  /** True if this was a dry-run (no GENERATION_ENDED received). */
  isDryRun?: boolean
  /** LLM provider name (e.g. "anthropic", "openai"). */
  provider?: string
  /** Model identifier (e.g. "claude-opus-4-6"). */
  model?: string
  /** Connection profile display name. */
  connectionName?: string
}

const MAX_PER_CHAT = 50

export class PromptStore {
  /** chatId → snapshots (oldest-first) */
  private chats = new Map<string, PromptSnapshot[]>()

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
    if (arr.length > MAX_PER_CHAT) arr.shift()
  }

  getLatest(chatId: string): PromptSnapshot | null {
    return this.getChat(chatId).at(-1) ?? null
  }

  /** Returns newest-first for a specific chat. */
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

  /** Link a messageId and number to the most recent snapshot for a given chat. */
  linkMessage(chatId: string, messageId: string, messageNumber?: number): void {
    const arr = this.getChat(chatId)
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!arr[i].messageId) {
        arr[i].messageId = messageId
        if (messageNumber !== undefined) {
          arr[i].messageNumber = messageNumber
        }
        return
      }
    }
  }

  /** Remove all snapshots linked to a given messageId. Returns number removed. */
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

  clearAll(): void {
    this.chats.clear()
  }

  count(chatId: string): number {
    return this.getChat(chatId).length
  }
}
