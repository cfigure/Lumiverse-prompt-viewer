# Prompt Viewer

A Spindle extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that lets you inspect the fully assembled prompt **after** it has been sent to the LLM — the same workflow as SillyTavern's prompt inspector.

## Features

- **Post-send inspection** — See the exact prompt that was sent, not a preview
- **Model info** — Shows the model used for each generation (e.g. `claude-opus-4.6`) in the status bar
- **Three view modes** — Formatted (color-coded collapsible blocks), Raw (JSON message array), and Rendered (clean readable text without role headers)
- **Dry-run separation** — Dry-runs are automatically detected and hidden by default, toggle them on with the ⚡ button
- **Per-chat history** — Prompts are separated by chat, switching chats auto-refreshes the viewer
- **Message linking** — Each captured prompt shows the chat message number it produced (e.g. #4)
- **Generation metadata** — Shows generation type, chat ID, connection, persona, and activated world info
- **Auto-updates** — New captures appear in real time while the tab is open, and auto-refresh when the tab is activated or chats are switched
- **Message deletion sync** — Deleting a message in chat removes its associated prompt from the viewer
- **Chat deletion cleanup** — Deleting a chat clears all its captured prompts
- **Copy to clipboard** — Export the current prompt in the active view mode
- **Token estimates** — Rough per-message and total token counts

## How It Works

**Backend** — Registers a passive interceptor via `spindle.registerInterceptor()` with priority 999 (runs last) so it captures the final prompt after all other interceptors have modified it. Returns the messages array unchanged. Tracks active generation IDs via `GENERATION_STARTED` to distinguish real generations from dry-runs and to capture model info. On `GENERATION_ENDED`, it looks up the real message index via `spindle.chat.getMessages()` and links it to the snapshot. On `CHAT_CHANGED`, it checks if the previous chat was deleted and cleans up its prompts.

**Frontend** — Registers a drawer tab in the ViewportDrawer sidebar. Listens for `CHAT_CHANGED` events to auto-refresh when switching chats. Auto-refreshes when the tab is activated. New captures are pushed from the backend in real time. Dry-runs are filtered out by default and can be toggled on with the ⚡ Dry Runs button.

## Permissions

| Permission       | Used for                                                                          |
|------------------|-----------------------------------------------------------------------------------|
| `interceptor`    | Passively capturing the assembled prompt                                          |
| `ui_panels`      | Drawer tab in the ViewportDrawer sidebar                                          |
| `generation`     | Listening to `GENERATION_STARTED`/`ENDED` for model info, dry-run detection, and message linking |
| `chat_mutation`  | Looking up message index via `getMessages()` for the `#N` label                   |
| `chats`          | Checking if a chat was deleted to clean up its prompts                            |

## Installation

### From GitHub

Go to **Settings → Extensions** and install from URL:

```
https://github.com/cfigure/Lumiverse-prompt-viewer
```

### Manual

```bash
cd data/extensions/prompt_viewer/repo
bun install
bun run build
```

Enable the extension and grant all five permissions when prompted.

## Usage

1. Open the **Prompt Viewer** tab in the sidebar drawer.
2. Send a message — the captured prompt appears automatically.
3. Switch chats — the viewer refreshes to show that chat's prompt history.
4. Use the **dropdown** to browse previous prompts (shows message number, timestamp, model, generation type).
5. Click any **message header** to collapse/expand it.
6. Toggle **{ } Raw** to see the exact JSON message array sent to the provider.
7. Toggle **◉ Rendered** to see the prompt as clean readable text without role headers.
8. Toggle **⚡ Dry Runs** to include dry-run prompts in the history (hidden by default, labeled `[DRY]`).
9. **Copy** exports the prompt in the current view mode.
10. **Clear** removes all captured prompts for the current chat (with confirmation).

## Project Structure

```
src/
  backend.ts              Backend worker — interceptor + event listeners + message handler
  frontend.ts             Frontend — drawer tab UI + chat switching + view modes
  storage/
    prompt-store.ts       Per-chat ring buffers for prompt history
  components/
    styles.ts             CSS using Lumiverse theme variables
spindle.json              Extension manifest
```

## Interceptor Context Reference

The interceptor receives `(messages, context)` where:

- `messages` — `LlmMessageDTO[]` — `{ role, content, name? }`
- `context` — `{ chatId, connectionId, personaId, generationType }`

`generationType` is one of: `normal`, `continue`, `regenerate`, `swipe`, `impersonate`, `quiet`.

## License

MIT
