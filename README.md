# Prompt Viewer

A Spindle extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that lets you inspect the fully assembled prompt **after** it has been sent to the LLM — the same workflow as SillyTavern's prompt inspector.

## Features

- **Post-send inspection** — See the exact prompt that was sent, not a preview
- **Model info** — Shows the model used for each generation in the status bar
- **Three view modes** — Formatted (color-coded collapsible blocks), Raw (JSON message array), and Rendered (clean readable text without role headers)
- **Dry-run separation** — Dry-runs are automatically detected and hidden by default, toggle them on with the ⚡ button
- **Per-chat history** — Prompts are separated by chat, switching chats auto-refreshes the viewer
- **Message linking** — Each captured prompt shows the chat message number it produced (e.g. #4)
- **Generation metadata** — Shows generation type, chat ID, connection, persona, and activated world info
- **Auto-updates** — New captures appear in real time, auto-refresh on tab activation and chat switching
- **Message deletion sync** — Deleting a message removes its associated prompt
- **Chat deletion cleanup** — Deleting a chat clears all its captured prompts
- **Copy to clipboard** — Export in the active view mode with "✓ Copied" feedback
- **Token estimates** — Rough per-message and total token counts
- **Configurable history** — Adjust max prompts per chat (default 50, up to 500)
- **Persistent settings** — Preferences persist across extension restarts via userStorage

## How It Works

**Backend** — Registers a passive interceptor via `spindle.registerInterceptor()` with priority 999 (runs last) so it captures the final prompt after all other interceptors have modified it. Returns the messages array unchanged. Tracks active generation IDs via `GENERATION_STARTED` to distinguish real generations from dry-runs and to capture model info. On `GENERATION_ENDED`, it looks up the real message index via `spindle.chat.getMessages()` and links it to the snapshot. On `CHAT_CHANGED`, it checks if the previous chat was deleted and cleans up its prompts. Settings are stored via `spindle.userStorage` for operator-scoped compatibility.

**Frontend** — Registers a drawer tab in the ViewportDrawer sidebar. Settings are rendered in the native Lumiverse Settings → Extensions panel via `ctx.ui.mount('settings_extensions')`. On first install, prompts the user to grant all required permissions via `ctx.permissions.request()`. Listens for `SPINDLE_PERMISSION_CHANGED` events to react when permissions are granted after the fact.

## Permissions

| Permission       | Used for                                                                          |
|------------------|-----------------------------------------------------------------------------------|
| `interceptor`    | Passively capturing the assembled prompt                                          |
| `generation`     | Listening to `GENERATION_STARTED`/`ENDED` for model info, dry-run detection, and message linking |
| `chat_mutation`  | Looking up message index via `getMessages()` for the `#N` label                   |
| `chats`          | Checking if a chat was deleted to clean up its prompts                            |

On first install, the extension will prompt you to grant all permissions at once.

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

**Note:** After granting permissions on first install, you may need to toggle the extension off and on once for prompt capturing to activate.

## Settings

Settings are accessible from **Settings → Extensions → Prompt Viewer**. A ⚙ button in the viewer toolbar also links there.

| Setting                | Default     | Description                                                |
|------------------------|-------------|------------------------------------------------------------|
| Default view mode      | Formatted   | Which view mode opens by default (Formatted, Raw, Rendered)|
| Show dry runs          | Off         | Whether dry-run prompts are visible by default             |
| Max prompts per chat   | 50          | How many prompts to keep in memory per chat (5–500)        |

Higher max values use more memory. Prompt data is not persisted to disk — history clears on restart.

## Usage

1. Open the **Prompt Viewer** tab in the sidebar drawer (or search "Prompts" in the command palette).
2. Send a message — the captured prompt appears automatically.
3. Switch chats — the viewer refreshes to show that chat's prompt history.
4. Use the **dropdown** to browse previous prompts (shows message number, timestamp, model, generation type).
5. Click any **message header** to collapse/expand it.
6. Toggle **{ } Raw** to see the exact JSON message array sent to the provider.
7. Toggle **◉ Rendered** to see the prompt as clean readable text without role headers.
8. Toggle **⚡ Dry Runs** to include dry-run prompts in the history (hidden by default, labeled `[DRY]`).
9. **Copy** exports the prompt in the current view mode.
10. **Clear** removes all captured prompts for the current chat (with confirmation).

## Storage

Prompt history is held **in memory only** and is not persisted to disk. All captured prompts are cleared when Lumiverse is restarted or the extension is toggled off. This is by design — prompt data can be large and storing it permanently would consume significant disk space.

Settings (view mode, dry-run preference, history limit) are persisted via `userStorage` and survive restarts.

## Project Structure

```
src/
  backend.ts              Backend worker — interceptor + event listeners + message handler
  frontend.ts             Frontend — drawer tab UI + settings + chat switching
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

## Changelog

### 1.0.2
- Added settings panel (view mode, dry runs, max history)
- Permission request on first install
- Switched to userStorage for settings persistence

### 1.0.1
- Fixed copy button not working in drawer tab context
- Copy button shows "✓ Copied" feedback

### 1.0.0
- Initial release

## License

MIT
