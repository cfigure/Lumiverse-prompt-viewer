import test from 'node:test'
import assert from 'node:assert/strict'

const listeners = new Map()
const sent = []
const userSettings = new Map()
let frontendHandler
let interceptor

globalThis.spindle = {
  permissions: { has: () => true, onChanged: () => {} },
  on: (event, handler) => listeners.set(event, handler),
  onFrontendMessage: (handler) => { frontendHandler = handler },
  registerInterceptor: (handler) => { interceptor = handler },
  sendToFrontend: (payload, userId, options) => {
    sent.push({ payload: structuredClone(payload), userId, options })
  },
  tokens: { countMessages: async () => ({ total_tokens: 8, approximate: false }) },
  connections: { get: async () => ({ provider: 'test-provider', model: 'test-model' }) },
  chat: { getMessages: async () => [] },
  userStorage: {
    getJson: async (_, { fallback, userId }) => userSettings.get(userId) ?? fallback,
    setJson: async (_, settings, { userId }) => { userSettings.set(userId, structuredClone(settings)) },
  },
  log: { info: () => {}, warn: () => {}, error: (message) => { throw new Error(message) } },
  toast: { error: (message) => { throw new Error(message) } },
}

await import('../dist/backend.js')

const emit = (event, payload, userId) => listeners.get(event)(payload, userId)
const request = async (payload, userId, session = `session-${userId}`) => {
  await frontendHandler(payload, userId, session)
  return sent.at(-1)
}
const capture = async (userId, chatId, dryRun, content = 'Prompt') => {
  await interceptor([{ role: 'user', content }], {
    userId, chatId, dryRun, connectionId: `connection-${userId}`, generationType: 'normal',
  })
  await new Promise((resolve) => setImmediate(resolve))
  const record = [...sent].reverse().find(({ payload, userId: target }) =>
    target === userId && payload.type === 'prompt_captured' && payload.snapshot.context.chatId === chatId
      && payload.snapshot.messages[0].content === content)
  assert.ok(record, 'capture should reach only the intended user')
  return record.payload.snapshot
}

test('operator worker isolates histories, settings replies, chat events, and IDs by user', async () => {
  const a = await capture('alice-109', 'shared-chat-id', true, 'Alice private prompt')
  const b = await capture('bob-109', 'shared-chat-id', true, 'Bob private prompt')
  assert.equal((await request({ type: 'get_by_id', id: a.id }, 'bob-109')).payload.snapshot, null)
  const aliceHistory = await request({ type: 'get_history', chatId: 'shared-chat-id' }, 'alice-109')
  assert.deepEqual(aliceHistory.payload.snapshots.map((s) => s.id), [a.id])
  assert.deepEqual(aliceHistory.options, { frontendSessionId: 'session-alice-109' })
  const bobHistory = await request({ type: 'get_history', chatId: 'shared-chat-id' }, 'bob-109')
  assert.deepEqual(bobHistory.payload.snapshots.map((s) => s.id), [b.id])
  emit('CHAT_SWITCHED', { chatId: 'shared-chat-id' }, 'alice-109')
  assert.equal(sent.at(-1).userId, 'alice-109')
  await request({ type: 'clear_history', chatId: 'shared-chat-id' }, 'alice-109')
  assert.deepEqual((await request({ type: 'get_history', chatId: 'shared-chat-id' }, 'bob-109')).payload.snapshots.map((s) => s.id), [b.id])
  await request({ type: 'save_settings', settings: { maxHistoryPerChat: 5 } }, 'alice-109')
  await request({ type: 'save_settings', settings: { maxHistoryPerChat: 12 } }, 'bob-109')
  assert.equal((await request({ type: 'get_settings' }, 'alice-109')).payload.settings.maxHistoryPerChat, 5)
  assert.equal((await request({ type: 'get_settings' }, 'bob-109')).payload.settings.maxHistoryPerChat, 12)
  const aliceDry = await capture('alice-109', 'shared-chat-id', true, 'After chat switch')
  const bobDry = await capture('bob-109', 'shared-chat-id', true, 'Same chat ID, other user')
  assert.equal(aliceDry.isLikelyAutoDryRun, true)
  assert.equal(bobDry.isLikelyAutoDryRun, undefined)
})

test('live completion cannot claim an intervening dry run when its capture is missing', async () => {
  const userId = 'missing-109'
  const chatId = 'missing-chat'
  const dry = await capture(userId, chatId, true, 'Dry run')
  await emit('GENERATION_ENDED', { generationId: 'missing-generation', chatId, messageId: 'live-message' }, userId)
  const history = (await request({ type: 'get_history', chatId }, userId)).payload.snapshots
  assert.equal(history.find((s) => s.id === dry.id).messageId, undefined)
})

test('staged swipe marks the upcoming capture without relabelling its predecessor', async () => {
  const userId = 'swipe-109'
  const chatId = 'swipe-chat'
  emit('GENERATION_STARTED', { generationId: 'gen-original', chatId, generationType: 'normal' }, userId)
  const original = await capture(userId, chatId, false, 'Original generation')
  await emit('GENERATION_ENDED', { generationId: 'gen-original', chatId, messageId: 'assistant-message' }, userId)
  emit('MESSAGE_SWIPED', {
    action: 'added', chatId, swipeId: 1,
    message: { id: 'assistant-message', swipes: ['Original', ''], content: '' },
  }, userId)
  emit('GENERATION_STARTED', {
    generationId: 'gen-swipe', chatId, generationType: 'regenerate',
    targetMessageId: 'assistant-message', targetSwipeId: 1,
  }, userId)
  const newer = await capture(userId, chatId, false, 'New swipe')
  globalThis.spindle.chat.getMessages = async () => [{ id: 'assistant-message', swipe_id: 0 }]
  await emit('GENERATION_ENDED', { generationId: 'gen-swipe', chatId, messageId: 'assistant-message' }, userId)
  const history = (await request({ type: 'get_history', chatId }, userId)).payload.snapshots
  assert.equal(history.find((s) => s.id === original.id).isSwipe, undefined)
  assert.equal(history.find((s) => s.id === newer.id).isSwipe, true)
  assert.equal(history.find((s) => s.id === newer.id).swipeIndex, 1)
})
