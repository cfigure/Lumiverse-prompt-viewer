// =============================================================================
// prompt-viewer — Backend (Bun worker)
// =============================================================================

import { PromptStore } from './storage/prompt-store'
import type { PromptSnapshot, LlmMessage, InterceptorMeta } from './storage/prompt-store'

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
  maxHistoryPerChat: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
  showWorldInfo: true,
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
// Content helper — LlmMessageDTO.content is always a string
// ---------------------------------------------------------------------------
function messageText(content: string): string {
  return content ?? ''
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
): Promise<{ tokens: number; approximate: boolean; tokenizer?: string }> {
  try {
    const opts: { model?: string; userId?: string } = {}
    if (model) opts.model = model
    if (userId) opts.userId = userId
    // lumiverse-spindle-types doesn't expose the tokens interface yet,
    // but the runtime provides it — cast through to access it.
    const api = spindle as any
    const result = await api.tokens.countMessages(
      messages.map((m) => ({ role: m.role, content: m.content })),
      opts,
    )
    return {
      tokens: result.total_tokens,
      approximate: result.approximate,
      tokenizer: result.tokenizer_name,
    }
  } catch {
    return {
      tokens: estimateTokensFallback(messages),
      approximate: true,
    }
  }
}

// ---------------------------------------------------------------------------
// Dry-run detection — track active generation IDs
// ---------------------------------------------------------------------------
const activeGenerations = new Set<string>()
const generationMeta = new Map<string, { model: string }>()

// ---------------------------------------------------------------------------
// OOC / regen feedback extraction
// ---------------------------------------------------------------------------
const OOC_PATTERN = /\[OOC:\s*([\s\S]*?)\]\s*$/

function extractRegenFeedback(
  messages: LlmMessage[],
): { feedback: string; position: 'system' | 'user' } | null {
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 4); i--) {
    const msg = messages[i]
    const text = messageText(msg.content)
    const match = text.match(OOC_PATTERN)
    if (match) {
      return {
        feedback: match[1].trim(),
        position: msg.role === 'system' ? 'system' : 'user',
      }
    }
  }
  return null
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

      const snapshot: PromptSnapshot = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        messages: structuredClone(messages) as LlmMessage[],
        context: structuredClone(ctx),
        estimatedTokens: estimateTokensFallback(messages as LlmMessage[]),
        isDryRun: activeGenerations.size === 0,
      }

      // Pull model and generationId from GENERATION_STARTED
      if (activeGenerations.size > 0) {
        const latestGenId = [...activeGenerations].at(-1)
        if (latestGenId) {
          snapshot.generationId = latestGenId
          const meta = generationMeta.get(latestGenId)
          if (meta) snapshot.model = meta.model
        }
      }

      // Async token count — fire and forget, update snapshot when ready
      countTokens(messages as LlmMessage[], snapshot.model, currentUserId).then((result) => {
        snapshot.estimatedTokens = result.tokens
        snapshot.approximateTokens = result.approximate
        if (result.tokenizer) snapshot.tokenizer = result.tokenizer
        spindle.sendToFrontend({ type: 'snapshot_updated', snapshot })
      })

      // Extract OOC regen feedback if present
      const ooc = extractRegenFeedback(messages as LlmMessage[])
      if (ooc) {
        snapshot.regenFeedback = ooc.feedback
        snapshot.regenFeedbackPosition = ooc.position
      }

      store.push(snapshot)
      activeChatId = ctx.chatId

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
      activeGenerations.add(payload.generationId)
      if (payload.model) {
        generationMeta.set(payload.generationId, { model: payload.model })
      }
    }
  })

  spindle.on('GENERATION_ENDED', async (payload: any) => {
    const genId = payload.generationId
    if (genId) {
      activeGenerations.delete(genId)
      generationMeta.delete(genId)
    }
    if (!payload.chatId || !payload.messageId) return

    try {
      const messages = await spindle.chat.getMessages(payload.chatId)
      const index = messages.findIndex((m: any) => m.id === payload.messageId)
      const msgNum = index !== -1 ? index + 1 : undefined
      store.linkMessage(payload.chatId, payload.messageId, msgNum, genId)

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
      generationMeta.delete(genId)

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

  const messageId = payload.message?.id
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
        snapshot: chatId ? store.getLatest(chatId) : null,
      })
      break

    case 'get_history':
      spindle.sendToFrontend({
        type: 'prompt_history',
        snapshots: chatId ? store.getAll(chatId) : [],
      })
      break

    case 'get_by_id':
      spindle.sendToFrontend({
        type: 'prompt_data',
        snapshot: store.getById(payload.id),
      })
      break

    case 'clear_history':
      if (chatId) store.clearChat(chatId)
      spindle.sendToFrontend({ type: 'history_cleared' })
      break

    case 'set_active_chat':
      activeChatId = payload.chatId
      spindle.sendToFrontend({
        type: 'prompt_history',
        snapshots: payload.chatId ? store.getAll(payload.chatId) : [],
      })
      break

    case 'get_settings': {
      const settings = await loadSettings()
      spindle.sendToFrontend({ type: 'settings_loaded', settings })
      break
    }

    case 'save_settings':
      try {
        await saveSettings(payload.settings)
        spindle.toast.success('Settings saved.')
      } catch (err: any) {
        spindle.toast.error(`Failed to save settings: ${err?.message ?? err}`)
      }
      break
  }
})

spindle.log.info('Prompt Viewer backend loaded.')
