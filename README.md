# Prompt Viewer

A Spindle extension for [Lumiverse](https://github.com/prolix-oc/Lumiverse) that lets you inspect the fully assembled chat prompt after it has been sent to the LLM.

## Features

- **Post-send chat capture** — See the assembled chat messages sent to the provider, not a preview
- **Three view modes** — Formatted (collapsible, colour-coded), Raw (JSON), Rendered (plain text)
- **Token counting with source labels** — Uses Lumiverse's tokenizer when available, distinguishing native counts, Lumiverse approximate counts, and Prompt Viewer chars/4 fallback
- **OOC feedback capture** — Regen-with-feedback instructions are extracted and displayed separately
- **World Info display** — Shows activated entries with source type and vector scores
- **Swipe vs regen labels** — Swipes are distinguished from plain regens with pending-swipe race handling
- **Abort tracking** — Stopped generations are marked
- **Dry-run separation** — Hidden by default, toggle with ⚡
- **Per-chat history** — Captures auto-refresh on chat switch
- **Message linking** — Each prompt shows the message number it produced
- **In-memory only** — History clears on restart, settings persist

## Installation

Install from URL in **Settings → Extensions**:

```text
https://github.com/cfigure/Lumiverse-prompt-viewer
```

After granting permissions on first install, you may need to toggle the extension off and on once.

## Permissions

- `interceptor` — captures assembled chat prompts.
- `generation` — tracks generation lifecycle events for model/action tagging.
- `chat_mutation` — reads chat messages for message numbering and deletion reconciliation.
- `chats` — keeps chat switching/current-chat behaviour compatible across Lumiverse builds.

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
| Show tokenizer source | On | Show whether the token number came from native Lumiverse token counting, Lumiverse approximate counting, or Prompt Viewer fallback |

Settings autosave as soon as they are changed.

## Known Limitations

- **Token counts may be approximate.** Token counts use Lumiverse’s native token counter when available. If Lumiverse does not have an exact tokenizer for the active model, it may return a rough estimate. Prompt Viewer also keeps a final fallback estimate based on character count.
- **OOC extraction is regex-based.** The interceptor context doesn't expose regen feedback directly, so the extension pattern-matches `[OOC: ...]` from message content. User-authored OOC text that exactly matches Lumiverse's injected shape may still be detected as regen feedback.
- **Swipe labeling is best-effort.** Prompt Viewer now tracks pending swipe-add events and applies them when the interceptor snapshot arrives, but very unusual event ordering can still leave a capture as Regen until a later update.
- **Deletion cleanup is best-effort.** Deleting messages that had multiple swipes or rapid regens may leave orphaned snapshots in the history. This is a timing issue — snapshots that haven't been linked to a message yet can't be cleaned up by message ID. Clearing all history with ✕ will always remove everything.

## Compatibility

Prompt Viewer 1.0.7 requires Lumiverse 1.0.0 or newer.

This version was updated for the current Lumiverse/Spindle APIs, including multipart message content, native token counting, updated chat events, and autosaving extension settings.

## Changelog

See [Releases](https://github.com/cfigure/Lumiverse-prompt-viewer/releases) for version history.

## License

MIT
