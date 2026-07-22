// =============================================================================
// Styles — uses Lumiverse CSS variables for theme integration
// =============================================================================

export const PANEL_CSS = /* css */ `
  /* ---- Toolbar ---- */
  .pv-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--lumiverse-border);
    flex-wrap: wrap;
  }
  .pv-toolbar button {
    background: var(--lumiverse-fill);
    color: var(--lumiverse-text-muted);
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
    transition: background var(--lumiverse-transition-fast),
                border-color var(--lumiverse-transition-fast);
  }
  .pv-toolbar button:hover {
    border-color: var(--lumiverse-border-hover);
  }
  .pv-toolbar button.pv-active {
    background: var(--lumiverse-accent);
    color: var(--lumiverse-accent-fg);
    border-color: var(--lumiverse-accent);
  }
  .pv-toolbar .pv-spacer { flex: 1; }
  .pv-toolbar .pv-status {
    font-size: 11px;
    color: var(--lumiverse-text-dim);
  }
  .pv-capture-select-slot {
    min-width: 170px;
  }

  /* ---- History dropdown ---- */
  .pv-history-select {
    background: var(--lumiverse-fill);
    color: var(--lumiverse-text);
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    padding: 3px 6px;
    font-size: 12px;
    max-width: 240px;
  }

  /* ---- Message list ---- */
  .pv-messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }

  /* ---- Individual message ---- */
  .pv-message {
    margin-bottom: 10px;
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    overflow: hidden;
  }
  .pv-message-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    user-select: none;
  }
  .pv-message-header .pv-toggle {
    font-size: 10px;
    color: var(--lumiverse-text-dim);
  }
  .pv-message-body {
    padding: 8px 10px;
    font-size: 13px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid var(--lumiverse-border);
    max-height: 400px;
    overflow-y: auto;
  }
  .pv-message-body.pv-collapsed { display: none; }

  /* ---- Role colors ---- */
  /* Use Lumiverse theme variables as base, with semi-transparent hue tints */
  .pv-role-system .pv-message-header  { background: color-mix(in srgb, var(--lumiverse-fill) 70%, hsl(120, 40%, 40%)); color: hsl(120, 45%, 65%); }
  .pv-role-system .pv-message-body    { background: color-mix(in srgb, var(--lumiverse-fill-subtle) 85%, hsl(120, 30%, 35%)); color: var(--lumiverse-text-muted); }

  .pv-role-user .pv-message-header    { background: color-mix(in srgb, var(--lumiverse-fill) 70%, hsl(220, 45%, 45%)); color: hsl(220, 50%, 70%); }
  .pv-role-user .pv-message-body      { background: color-mix(in srgb, var(--lumiverse-fill-subtle) 85%, hsl(220, 35%, 40%)); color: var(--lumiverse-text-muted); }

  .pv-role-assistant .pv-message-header { background: color-mix(in srgb, var(--lumiverse-fill) 70%, hsl(300, 35%, 40%)); color: hsl(300, 40%, 70%); }
  .pv-role-assistant .pv-message-body   { background: color-mix(in srgb, var(--lumiverse-fill-subtle) 85%, hsl(300, 25%, 35%)); color: var(--lumiverse-text-muted); }


  /* ---- Context block ---- */
  .pv-context-block {
    margin-bottom: 10px;
    padding: 8px 10px;
    background: var(--lumiverse-fill-subtle);
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    font-size: 12px;
    font-family: monospace;
    white-space: pre-wrap;
    color: var(--lumiverse-text-muted);
    max-height: 180px;
    overflow-y: auto;
  }

  /* ---- OOC / Regen feedback block ---- */
  .pv-ooc-block {
    border-color: color-mix(in srgb, var(--lumiverse-border) 50%, hsl(35, 80%, 55%));
    background: color-mix(in srgb, var(--lumiverse-fill-subtle) 85%, hsl(35, 60%, 40%));
    color: hsl(35, 55%, 70%);
  }
  .pv-ooc-heading {
    font-weight: 600;
    margin-bottom: 4px;
    color: hsl(35, 65%, 78%);
  }
  .pv-ooc-body {
    font-family: monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ---- Header right-side group (badge + copy + toggle) ---- */
  .pv-header-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .pv-block-copy {
    background: none;
    border: none;
    padding: 0 2px;
    margin: 0;
    cursor: pointer;
    color: inherit;
    font-size: 12px;
    line-height: 1;
    opacity: 0.65;
  }
  .pv-block-copy:hover { opacity: 1; }
  .pv-ooc-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  /* ---- Rejected message sub-block (regen-with-previous-message) ---- */
  .pv-rejected-block {
    margin-top: 8px;
    border: 1px solid color-mix(in srgb, var(--lumiverse-border) 50%, hsl(35, 80%, 55%));
  }
  .pv-rejected-block .pv-message-header {
    background: color-mix(in srgb, var(--lumiverse-fill) 75%, hsl(35, 55%, 40%));
    color: hsl(35, 55%, 70%);
  }

  /* ---- Rendered view: Prompt Breakdown-style headings/separators ---- */
  .pv-rendered-sep {
    font-family: monospace;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.3px;
    color: var(--lumiverse-text-muted);
    margin: 14px 0 6px;
    white-space: pre-wrap;
  }
  .pv-rendered-sep:first-child { margin-top: 0; }

  /* ---- World Info entries block ---- */
  .pv-wi-block {
    border-color: color-mix(in srgb, var(--lumiverse-border) 50%, hsl(200, 60%, 50%));
    background: color-mix(in srgb, var(--lumiverse-fill-subtle) 85%, hsl(200, 40%, 35%));
    color: hsl(200, 45%, 70%);
    max-height: 200px;
  }

  /* ---- Aborted generation indicator ---- */
  .pv-role-system .pv-message-header.pv-aborted,
  .pv-role-user .pv-message-header.pv-aborted,
  .pv-role-assistant .pv-message-header.pv-aborted {
    background: color-mix(in srgb, var(--lumiverse-fill) 70%, hsl(0, 50%, 40%));
  }

  /* ---- Token badge ---- */
  .pv-token-badge {
    display: inline-block;
    background: var(--lumiverse-fill-subtle);
    color: var(--lumiverse-text-dim);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    margin-left: 6px;
  }

  /* ---- Raw view ---- */
  .pv-raw {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--lumiverse-text-muted);
    tab-size: 2;
  }

  /* ---- Rendered view ---- */
  .pv-rendered {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--lumiverse-text);
  }
  .pv-rendered-block {
    padding: 8px 0;
    border-bottom: 1px solid var(--lumiverse-border);
  }
  .pv-rendered-block:last-child {
    border-bottom: none;
  }

  /* ---- Empty state ---- */
  .pv-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--lumiverse-text-dim);
    font-size: 13px;
    text-align: center;
    padding: 20px;
  }

  /* ---- Settings (settings_extensions mount) ---- */
  .pv-settings {
    padding: 0;
  }
  .pv-settings-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--lumiverse-text);
    padding: 12px 16px 8px;
  }
  .pv-settings-card {
    padding: 8px 16px 16px;
  }
  .pv-settings-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 20px;
    min-height: 44px;
    padding: 10px 0;
    border-bottom: 1px solid var(--lumiverse-border);
  }
  .pv-settings-row:last-of-type {
    border-bottom: none;
  }
  .pv-settings-label-block {
    min-width: 0;
    padding-right: 12px;
  }
  .pv-settings-label {
    display: block;
    font-size: 13px;
    color: var(--lumiverse-text);
  }
  .pv-settings-control {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    min-width: 160px;
    max-width: 240px;
  }
  .pv-shared-slot {
    display: flex;
    justify-content: flex-end;
    min-width: 160px;
  }
  .pv-settings-hint,
  .pv-settings-status {
    font-size: 11px;
    color: var(--lumiverse-text-dim);
    margin-top: 4px;
  }
  .pv-settings-status {
    padding-top: 8px;
    min-height: 14px;
  }
  .pv-settings-input {
    background: var(--lumiverse-fill);
    color: var(--lumiverse-text);
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lumiverse-radius);
    padding: 4px 8px;
    font-size: 12px;
    min-width: 100px;
  }
  .pv-settings-note {
    font-size: 11px;
    color: var(--lumiverse-text-dim);
    padding: 10px 0 6px;
    font-style: italic;
  }
`
