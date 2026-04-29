# Prompt Viewer

A Spindle extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that lets you inspect the fully assembled prompt after it has been sent to the LLM.

**Requires Lumiverse commit `5127cce` or later** (spindle-types 0.4.46+).

Only tested against the latest staging branch. Older builds may be missing events this extension depends on (`CHAT_SWITCHED`, `CHAT_DELETED`, `MESSAGE_SWIPED`).

## Features

- **Post-send capture** — See the exact messages sent to the provider, not a preview
- **Three view modes** — Formatted (collapsible, color-coded), Raw (JSON), Rendered (plain text)
- **OOC feedback capture** — Regen-with-feedback instructions are extracted and displayed separately
- **Swipe vs regen labels** — Swipes are distinguished from plain regens where possible
- **Abort tracking** — Stopped generations are marked
- **Dry-run separation** — Hidden by default, toggle with ⚡
- **Per-chat history** — Auto-refreshes on chat switch
- **Message linking** — Each prompt shows the message number it produced
- **In-memory only** — History clears on restart, settings persist

## Installation

Install from URL in **Settings → Extensions**:

```
https://github.com/cfigure/Lumiverse-prompt-viewer
```

After granting permissions on first install, you may need to toggle the extension off and on once.

## Permissions

| Permission | Used for |
|---|---|
| `interceptor` | Capturing the assembled prompt |
| `generation` | Model info, dry-run detection, message linking |
| `chat_mutation` | Message index lookup for the #N label |
| `chats` | Chat deletion cleanup |

## Settings

Accessible from **Settings → Extensions → Prompt Viewer** or the ⚙ button in the toolbar.

| Setting | Default | Description |
|---|---|---|
| Default view mode | Formatted | Formatted, Raw, or Rendered |
| Show dry runs | Off | Include dry-run prompts in history |
| Max prompts per chat | 50 | 5–500 |

## Known Limitations

- **OOC extraction is regex-based.** The interceptor context doesn't expose regen feedback directly, so the extension pattern-matches `[OOC: ...]` from message content. False positives are possible if that pattern appears in character cards or world books.
- **Swipe labeling is best-effort.** Swipes and regens both arrive as `generationType: "regenerate"` in the interceptor context. The extension uses `MESSAGE_SWIPED` events to retroactively tag swipes, but event timing can cause a swipe to show as "Regen" until the next action.

## Changelog

### 1.0.4
- OOC feedback capture and display
- Swipe discrimination via `MESSAGE_SWIPED`
- Abort tracking via `GENERATION_STOPPED`
- `CHAT_SWITCHED` and `CHAT_DELETED` event support
- Multipart message content handling

### 1.0.3
- Message deletion sync and orphan cleanup
- Snapshot linking via `generationId`
- Theme-aware role colors

### 1.0.2
- Settings panel, permission request on first install

### 1.0.1
- Copy button fix

### 1.0.0
- Initial release

## License

MIT
