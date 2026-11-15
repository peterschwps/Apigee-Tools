// Styles of the dashboard element, adopted as a constructable stylesheet, so
// the strict content security policy needs no inline styles.
import { css } from 'lit';

export const styles = css`
  :host {
    /* vscode-tab-header draws the active underline in this color */
    --vscode-panelTitle-activeForeground: var(
      --vscode-panelTitle-activeBorder,
      var(--vscode-focusBorder)
    );

    display: block;
    max-width: 1600px;
    margin: 0 auto;
  }

  [hidden] {
    display: none !important;
  }

  h1,
  h2,
  h3 {
    margin: 0;
    font-weight: 600;
  }

  h1 {
    font-size: 20px;
    white-space: nowrap;
  }

  h2,
  h3 {
    font-size: 13px;
  }

  p {
    margin: 0;
  }

  a,
  .link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }

  a:hover,
  .link:hover {
    color: var(--vscode-textLink-activeForeground);
    text-decoration: underline;
  }

  a:focus-visible,
  .link:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
    border-radius: 2px;
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .muted {
    color: var(--at-text-muted);
  }

  /* Status colors only ever color icons, dots, and borders, never text */
  .tone-success {
    color: var(--at-success);
  }

  .tone-warning {
    color: var(--at-warning);
  }

  .tone-error {
    color: var(--at-error);
  }

  .tone-neutral {
    color: var(--at-neutral);
  }

  .tone-info {
    color: var(--at-info);
  }

  /* Header: the title and the session, with the context selects in a row below */
  .topbar {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-areas: 'brand session' 'context context';
    align-items: center;
    gap: 10px 24px;
    padding: 14px 20px 10px;
    /* Keyboard focus follows the rows: the selects come after Refresh */
    reading-flow: grid-rows;
  }

  .brand {
    grid-area: brand;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .context {
    grid-area: context;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
  }

  .session {
    grid-area: session;
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field-label {
    color: var(--at-text-muted);
    font-weight: normal;
  }

  /* Wide enough for 30-character project IDs; the option list copies the width */
  #organization,
  #environment {
    width: 250px;
    max-width: 100%;
  }

  /* A long account name shortens, so Refresh always stays in view */
  .account {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--at-text-muted);
    white-space: nowrap;
  }

  .address {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .account vscode-icon {
    color: inherit;
  }

  /* Tabs */
  vscode-tabs {
    padding: 0 20px;
  }

  .card vscode-tabs {
    padding: 0;
  }

  /* A 2px active indicator; the header's own underline is only 1px */
  vscode-tab-header[active] {
    box-shadow: inset 0 -2px 0 var(--vscode-panelTitle-activeForeground);
  }

  .tab-label {
    color: var(--vscode-panelTitle-inactiveForeground);
  }

  vscode-tab-header[active] .tab-label,
  vscode-tab-header:hover .tab-label {
    color: var(--at-text);
  }

  .page {
    display: grid;
    gap: 16px;
    padding: 16px 0 20px;
  }

  .messages {
    display: grid;
    gap: 12px;
    padding: 4px 20px 0;
  }

  .messages:empty {
    display: none;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 24px 20px;
    color: var(--at-text-muted);
  }

  /* The size of an icon, not the 28 px of VS Code Elements */
  .loading vscode-progress-ring {
    width: 16px;
    height: 16px;
  }

  /* Notices: a colored edge and icon, theme-colored text */
  .notice {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 4px 10px;
    padding: 10px 12px;
    border: 1px solid var(--vscode-contrastBorder, transparent);
    border-left: 3px solid var(--notice-color);
    border-radius: 2px;
    background: color-mix(
      in srgb,
      var(--notice-color) var(--at-fill),
      transparent
    );
  }

  .notice.error {
    --notice-color: var(--at-error);
  }

  .notice.warning {
    --notice-color: var(--at-warning);
  }

  .notice.info {
    --notice-color: var(--at-neutral);
  }

  .notice > vscode-icon {
    grid-row: span 3;
    color: var(--notice-color);
  }

  .notice > strong,
  .notice > p,
  .notice > .actions {
    grid-column: 2;
  }

  /* Dismiss, at the top right, without making the first line taller */
  .notice > .close {
    grid-column: 3;
    grid-row: 1;
    margin: -3px -6px -3px 0;
  }

  .notice .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin-top: 6px;
  }

  /* Overview */
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin: 0;
  }

  .kpi,
  .card {
    min-width: 0;
    border: 1px solid var(--at-border);
    border-radius: 6px;
    background: var(--at-surface-raised);
  }

  .kpi {
    padding: 10px 14px;
  }

  .kpi dt {
    color: var(--at-text-muted);
  }

  .kpi dd {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 600;
    line-height: 28px;
  }

  .card {
    padding: 12px 16px;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 16px;
  }

  .list,
  .chips {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .list > li + li {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--at-border);
  }

  .item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .item-name {
    font-weight: 600;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .path,
  .item-name {
    overflow-wrap: anywhere;
  }

  .path {
    margin-top: 2px;
    color: var(--at-text-muted);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }

  .finding {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Tables */
  /* Positioned, so screen-reader-only text cannot widen the page */
  .table-scroll {
    position: relative;
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid var(--at-border);
    text-align: left;
    white-space: nowrap;
  }

  /* As VS Code's own tables: the size of the cells, in bold */
  thead th {
    color: var(--at-text);
    font-weight: bold;
  }

  tbody th {
    font-weight: normal;
  }

  tbody tr:last-child > * {
    border-bottom: 0;
  }

  tbody tr:hover {
    background: var(--vscode-list-hoverBackground);
  }

  td[data-tooltip] {
    cursor: help;
  }

  .empty {
    padding: 16px 8px;
    color: var(--at-text-muted);
    text-align: center;
    white-space: normal;
  }

  /* Deployments: narrow columns at the right; the name takes the rest */
  .deployments .icon-cell,
  .deployments .revision {
    width: 1%;
    padding-inline: 16px;
    text-align: center;
  }

  /* Columns of the details that are as narrow as their content */
  .deployments .fit {
    width: 1%;
    padding-inline: 16px;
  }

  /* A button takes no more height than an icon, so every row is one height */
  .deployments .icon-button {
    margin-block: -3px;
  }

  /* Border-box also for links, which are content-box by default */
  .icon-button {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 5px;
    background: none;
    color: var(--vscode-icon-foreground, inherit);
    cursor: pointer;
  }

  /* Links that look like icon buttons keep their color and get no underline */
  .icon-button:hover {
    border-color: var(--vscode-toolbar-hoverOutline, transparent);
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-icon-foreground, inherit);
    text-decoration: none;
  }

  .icon-button:active {
    background: var(
      --vscode-toolbar-activeBackground,
      var(--vscode-toolbar-hoverBackground)
    );
  }

  .icon-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
    border-radius: 5px;
  }

  .problems {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .problems li {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 8px;
  }

  .problems .detail {
    grid-column: 2;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Deployments */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
  }

  .toolbar vscode-textfield {
    width: 280px;
    max-width: 100%;
  }

  /* Tooltips in VS Code's hover colors, above everything else */
  .tooltip {
    position: fixed;
    z-index: 10;
    max-width: min(480px, calc(100vw - 16px));
    padding: 4px 8px;
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--at-border));
    border-radius: 4px;
    background: var(
      --vscode-editorHoverWidget-background,
      var(--at-surface-raised)
    );
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
    color: var(--vscode-editorHoverWidget-foreground, var(--at-text));
    font-size: 12px;
    line-height: 1.4;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }

  .count {
    margin-left: auto;
    color: var(--at-text-muted);
  }

  /* Details of a proxy or shared flow */
  .details-head {
    display: grid;
    gap: 4px;
  }

  /* An icon button with a label */
  .labeled {
    width: auto;
    gap: 2px;
    padding: 0 6px 0 2px;
    font: inherit;
  }

  /* The icon lines up with the title */
  .back {
    justify-self: start;
    margin: 0 0 8px -3px;
  }

  /* A column name with its sort or filter button, centered on the text */
  .column-head {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  /*
   * Smaller and grey, so the column names come first; hover and an active
   * filter bring the icon to the front
   */
  .column-head .icon-button {
    width: 18px;
    height: 18px;
    margin-block: -1px;
    color: var(--at-text-muted);
  }

  .column-head .icon-button:hover,
  .column-head .icon-button.active {
    color: var(--vscode-icon-foreground, inherit);
  }

  /* vscode-icon sets the icon color itself; here it follows the button */
  .column-head vscode-icon {
    color: inherit;
  }

  /* Menus of the column filters, in VS Code's menu colors */
  .menu {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 4px;
    border: 1px solid var(--vscode-menu-border, var(--at-border));
    border-radius: 5px;
    background: var(--vscode-menu-background, var(--at-surface-raised));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
    color: var(--vscode-menu-foreground, var(--at-text));
    /* Not bold like the header that holds it */
    font-weight: normal;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 10px 3px 6px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .menu-item:hover,
  .menu-item:focus-visible {
    outline: none;
    background: var(
      --vscode-menu-selectionBackground,
      var(--vscode-list-hoverBackground)
    );
    color: var(--vscode-menu-selectionForeground, inherit);
  }

  .menu-item .unchecked {
    visibility: hidden;
  }

  /* Takes the place of a state icon in "All" */
  .no-icon {
    width: 16px;
  }

  .details-title {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .details-title h2 {
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  .details-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }
`;
