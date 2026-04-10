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
  .pv-toolbar .pv-spacer { flex: 1; }
  .pv-toolbar .pv-status {
    font-size: 11px;
    color: var(--lumiverse-text-dim);
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
  .pv-role-system .pv-message-header  { background: #172317; color: #6fbf6f; }
  .pv-role-system .pv-message-body    { background: #0f170f; color: #b0d0b0; }

  .pv-role-user .pv-message-header    { background: #171b2a; color: #6f8fbf; }
  .pv-role-user .pv-message-body      { background: #0f1120; color: #b0c0d8; }

  .pv-role-assistant .pv-message-header { background: #251725; color: #bf6fbf; }
  .pv-role-assistant .pv-message-body   { background: #1a0f1a; color: #d0b0d0; }

  /* ---- Context / params block ---- */
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

  /* ---- Active toggle button ---- */
  .pv-toolbar button.pv-active {
    background: var(--lumiverse-accent);
    color: var(--lumiverse-accent-fg);
    border-color: var(--lumiverse-accent);
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
`
