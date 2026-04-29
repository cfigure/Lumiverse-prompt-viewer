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
  maxHistoryPerChat: number
}

const DEFAULT_SETTINGS: Settings = {
  defaultViewMode: 'formatted',
  showDryRunsByDefault: false,
  dryRunMode: 'only',
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
// Token estimator
// ---------------------------------------------------------------------------
function estimateTokens(messages: LlmMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    chars += (msg.role?.length ?? 0) + (msg.content?.length ?? 0)
  }
  return Math.ceil(chars / 4)
}

// ---------------------------------------------------------------------------
// Dry-run detection — track active generation IDs
// ---------------------------------------------------------------------------
const activeGenerations = new Set<string>()
const generationMeta = new Map<string, { model: string }>()

spindle.on('GENERATION_STARTED', (payload: any) => {
  if (payload.generationId) {
    activeGenerations.add(payload.generationId)
    if (payload.model) {
      generationMeta.set(payload.generationId, { model: payload.model })
    }
  }
})

// ---------------------------------------------------------------------------
// Interceptor — passive tap
// ---------------------------------------------------------------------------
spindle.registerInterceptor(async (messages, context) => {
  try {
    const ctx = context as InterceptorMeta

    const snapshot: PromptSnapshot = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      messages: structuredClone(messages) as LlmMessage[],
      context: structuredClone(ctx),
      estimatedTokens: estimateTokens(messages as LlmMessage[]),
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

// ---------------------------------------------------------------------------
// Chat tracking
// ---------------------------------------------------------------------------
spindle.on('CHAT_CHANGED', async (payload: any) => {
  const chatId = payload.chatId ?? payload.chat?.id
  if (chatId) {
    const previousChatId = activeChatId
    activeChatId = chatId

    // Check if previous chat was deleted
    if (previousChatId && previousChatId !== chatId) {
      try {
        const prev = await spindle.chats.get(previousChatId)
        if (!prev) store.clearChat(previousChatId)
      } catch {
        // API error — assume deleted to be safe
        store.clearChat(previousChatId)
      }
    }

    spindle.sendToFrontend({
      type: 'chat_changed',
      chatId,
      snapshots: store.getAll(chatId),
    })
  }
})

// ---------------------------------------------------------------------------
// Frontend message handler
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: any, userId: string) => {
  // Track userId for userStorage calls
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

spindle.log.info('Prompt Viewer backend loaded — interceptor registered.')

// ---------------------------------------------------------------------------
// Generation events
// ---------------------------------------------------------------------------
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
  if (payload.generationId) {
    activeGenerations.delete(payload.generationId)
    generationMeta.delete(payload.generationId)
  }
})

spindle.on('MESSAGE_DELETED', async (payload: any) => {
  const chatId = payload.chatId || activeChatId
  if (!chatId) return

  let removed = 0

  // Try direct match by messageId
  if (payload.messageId) {
    removed += store.deleteByMessageId(payload.messageId)
  }

  // If direct match didn't find anything, the deleted message might be the
  // user message that preceded an assistant response. Rebuild messageNumber
  // links by re-reading the current message list so stale snapshots don't
  // reference messages that no longer exist.
  if (removed === 0 && payload.messageId) {
    try {
      const currentMessages = await spindle.chat.getMessages(chatId)
      const currentIds = new Set(currentMessages.map((m: any) => m.id))
      const snapshots = store.getAll(chatId)
      for (const snap of snapshots) {
        if (snap.messageId && !currentIds.has(snap.messageId)) {
          // This snapshot's linked message no longer exists — remove it
          store.deleteByMessageId(snap.messageId)
          removed++
        }
      }
    } catch {
      // Can't verify — skip
    }
  }

  // Always notify frontend of current state after a deletion event
  spindle.sendToFrontend({
    type: 'prompt_history',
    snapshots: store.getAll(chatId),
  })
})
