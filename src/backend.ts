// =============================================================================
// prompt-viewer — Backend (Bun worker)
// =============================================================================
// Registers a read-only interceptor that captures every assembled prompt
// and pushes it to the frontend via Spindle messaging.
//
// Permissions required: interceptor, ui_panels
// =============================================================================

import { PromptStore } from './storage/prompt-store'
import type { PromptSnapshot, LlmMessage, InterceptorMeta } from './storage/prompt-store'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const store = new PromptStore()
let activeChatId: string | null = null

// Track active generation IDs — if the interceptor fires while a generation is
// active, it's a real generation. If not, it's a dry-run.
const activeGenerations = new Set<string>()

// Cache model/provider info from GENERATION_STARTED — it has the model right in the payload
const generationMeta = new Map<string, { model: string; characterName?: string }>()

spindle.on('GENERATION_STARTED', (payload: any) => {
  if (payload.generationId) {
    activeGenerations.add(payload.generationId)
    if (payload.model) {
      generationMeta.set(payload.generationId, {
        model: payload.model,
        characterName: payload.characterName,
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Rough token estimator (chars / 4 heuristic)
// ---------------------------------------------------------------------------
function estimateTokens(messages: LlmMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    chars += (msg.role?.length ?? 0) + (msg.content?.length ?? 0)
  }
  return Math.ceil(chars / 4)
}

// ---------------------------------------------------------------------------
// Interceptor — passive tap
//
// The handler receives (messages, context) per the Spindle API.
// We deep-copy everything, stash it, push it to the frontend, and return
// the messages array UNCHANGED so we don't affect the generation.
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

    // Pull model info from the most recent GENERATION_STARTED event
    if (activeGenerations.size > 0) {
      const latestGenId = [...activeGenerations].at(-1)
      if (latestGenId) {
        const meta = generationMeta.get(latestGenId)
        if (meta) {
          snapshot.model = meta.model
        }
      }
    }

    store.push(snapshot)

    // Track the active chat from the interceptor context
    activeChatId = ctx.chatId

    // Push to frontend immediately so the panel can auto-update
    spindle.sendToFrontend({
      type: 'prompt_captured',
      snapshot,
    })
  } catch (err: any) {
    // Never let the viewer crash a generation
    spindle.log.error(`Failed to capture prompt: ${err?.message ?? err}`)
  }

  // CRITICAL: return the messages array unchanged — we are read-only
  return messages
}, 999) // High priority number = runs late, after other interceptors have
       // finished modifying the prompt. We want to see the *final* version.

// ---------------------------------------------------------------------------
// Track the active chat
// ---------------------------------------------------------------------------
spindle.on('CHAT_CHANGED', async (payload: any) => {
  const chatId = payload.chatId ?? payload.chat?.id
  if (chatId) {
    const previousChatId = activeChatId
    activeChatId = chatId

    // Check if the previous chat was deleted — if so, clear its prompts
    if (previousChatId && previousChatId !== chatId) {
      try {
        await spindle.chats.get(previousChatId)
      } catch {
        // Chat no longer exists — clean up its prompts
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
// Frontend message handler — responds to requests from the drawer tab
// ---------------------------------------------------------------------------
spindle.onFrontendMessage(async (payload: any, _userId: string) => {
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

    case 'get_status':
      spindle.sendToFrontend({
        type: 'status',
        count: chatId ? store.count(chatId) : 0,
      })
      break

    case 'set_active_chat':
      // Frontend tells us which chat it's viewing
      activeChatId = payload.chatId
      spindle.sendToFrontend({
        type: 'prompt_history',
        snapshots: payload.chatId ? store.getAll(payload.chatId) : [],
      })
      break
  }
})

spindle.log.info('Prompt Viewer backend loaded — interceptor registered.')

// ---------------------------------------------------------------------------
// Event listeners — link generations to messages, handle deletions
// ---------------------------------------------------------------------------

// When a generation finishes, look up the actual message index from the chat
spindle.on('GENERATION_ENDED', async (payload: any) => {
  if (payload.generationId) {
    activeGenerations.delete(payload.generationId)
    generationMeta.delete(payload.generationId)
  }
  if (!payload.chatId || !payload.messageId) return

  try {
    // Use chat_mutation to get all messages and find the real index
    const messages = await spindle.chat.getMessages(payload.chatId)
    const index = messages.findIndex((m: any) => m.id === payload.messageId)
    // Lumiverse UI shows 1-based numbering
    const msgNum = index !== -1 ? index + 1 : undefined

    store.linkMessage(payload.chatId, payload.messageId, msgNum)

    // Re-push the updated snapshot so the frontend gets the message number
    const updated = store.getAll(payload.chatId).find((s) => s.messageId === payload.messageId)
    if (updated) {
      spindle.sendToFrontend({
        type: 'snapshot_updated',
        snapshot: updated,
      })
    }
  } catch (err: any) {
    // chat_mutation permission might not be granted — fall back to no number
    store.linkMessage(payload.chatId, payload.messageId)
    spindle.log.warn(`Could not get message index: ${err?.message ?? err}`)
  }
})

// Clean up on stopped generations too
spindle.on('GENERATION_STOPPED', (payload: any) => {
  if (payload.generationId) {
    activeGenerations.delete(payload.generationId)
    generationMeta.delete(payload.generationId)
  }
})

// When a message is deleted, remove the associated snapshot(s)
spindle.on('MESSAGE_DELETED', (payload: any) => {
  if (payload.messageId) {
    const removed = store.deleteByMessageId(payload.messageId)
    if (removed > 0) {
      spindle.log.info(`Removed ${removed} snapshot(s) for deleted message ${payload.messageId}`)
      // Notify frontend to refresh with the current chat's history
      if (payload.chatId || activeChatId) {
        const chatId = payload.chatId || activeChatId
        spindle.sendToFrontend({
          type: 'prompt_history',
          snapshots: store.getAll(chatId),
        })
      }
    }
  }
})
