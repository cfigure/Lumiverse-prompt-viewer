# Prompt Viewer

A Spindle extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that lets you inspect the fully assembled prompt after it has been sent to the LLM.

**Requires Lumiverse commit `5127cce` or later** (spindle-types 0.4.46+).

## Features

- **Post-send capture** — See the exact messages sent to the provider, not a preview
- **Three view modes** — Formatted (collapsible, color-coded), Raw (JSON), Rendered (plain text)
- **Token counting** — Uses Lumiverse's tokenizer when available, falls back to chars/4 estimate
- **OOC feedback capture** — Regen-with-feedback instructions are extracted and displayed separately
- **World Info display** — Shows activated entries with source type and vector scores
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
| `generation` | Model info, dry-run detection, message linking, abort tracking |
| `chat_mutation` | Message list access for the #N label and deletion cleanup |
| `chats` | Chat list access |

## Settings

Accessible from **Settings → Extensions → Prompt Viewer** or the ⚙ button in the toolbar.

| Setting | Default | Description |
|---|---|---|
| Default view mode | Formatted | Formatted, Raw, or Rendered |
| Show dry runs by default | Off | Include dry-run prompts in history |
| Dry run display | Dry runs only | Show dry runs only, or alongside normal prompts |
| Show World Info entries | On | Display activated World Info entries with source type and scores |
| Show Regen Feedback at top | On | Display the OOC feedback banner above the prompt |
| Max prompts per chat | 50 | 5–500; higher values use more memory |

## Known Limitations

- **OOC extraction is regex-based.** The interceptor context doesn't expose regen feedback directly, so the extension pattern-matches `[OOC: ...]` from message content. False positives are possible if that pattern appears in character cards or world books.
- **Swipe labeling is best-effort.** Swipes and regens both arrive as `generationType: "regenerate"` in the interceptor context. The extension uses `MESSAGE_SWIPED` events to retroactively tag swipes, but event timing can cause a swipe to show as "Regen" until the next action.
- **Native Prompt Breakdown triggers dry runs.** Switching view modes in Lumiverse's built-in Prompt Breakdown re-runs assembly, which the extension captures as dry-run snapshots. These are hidden by default unless ⚡ is toggled on.
- **Deletion cleanup is best-effort.** Deleting messages that had multiple swipes or rapid regens may leave orphaned snapshots in the history. This is a timing issue — snapshots that haven't been linked to a message yet can't be cleaned up by message ID. Clearing all history with ✕ will always remove everything.

## Changelog

See [Releases](https://github.com/cfigure/Lumiverse-prompt-viewer/releases) for version history.

## License

MIT
