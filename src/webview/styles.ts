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
    font-size: 15px;
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

  /* Header: brand, context selects, and session; the selects get a row of their own when narrow */
  .topbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    grid-template-areas: 'brand context session';
    align-items: center;
    gap: 8px 24px;
    padding: 12px 20px 10px;
    /* Keyboard focus follows the rows, also when the selects move below Refresh */
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
  }

  /* Logo motif: a red and a yellow dot and a larger green one, joined by short connectors */
  .logo {
    display: flex;
    align-items: center;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dot.error {
    background: var(--at-error);
  }

  .dot.warning {
    background: var(--at-warning);
  }

  .dot.success {
    width: 14px;
    height: 14px;
    background: var(--at-success);
  }

  .connector {
    width: 5px;
    height: 2px;
    margin: 0 1px;
    border-radius: 1px;
    background: var(--at-decor);
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

  #organization,
  #environment {
    width: 170px;
  }

  @media (max-width: 1099px) {
    .topbar {
      grid-template-columns: 1fr auto;
      grid-template-areas: 'brand session' 'context context';
      row-gap: 2px;
    }

    /* Labels above the selects keep both in one row at narrow widths */
    .field {
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
    }
  }

  .account {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--at-text-muted);
    white-space: nowrap;
  }

  .account vscode-icon {
    color: inherit;
  }

  /* Wide enough for "Refreshing…", so the header does not shift while loading */
  .session vscode-button {
    min-width: 124px;
  }

  /* Tabs */
  vscode-tabs {
    padding: 0 20px;
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

  .content {
    padding: 16px 20px 20px;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 24px 20px;
    color: var(--at-text-muted);
  }

  /* Notices: a colored edge and icon, theme-colored text */
  .notice {
    display: grid;
    grid-template-columns: auto 1fr;
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

  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    margin: 0;
  }

  .facts dt {
    color: var(--at-text-muted);
  }

  .facts dd {
    margin: 0;
  }

  .list,
  .chips,
  .hosts {
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

  .hosts,
  .path {
    margin-top: 2px;
    color: var(--at-text-muted);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }

  .findings {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin-top: 2px;
  }

  .finding {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  /* Tables */
  .table-scroll {
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

  thead th {
    color: var(--at-text-muted);
    font-size: 12px;
    font-weight: 600;
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

  td[title] {
    cursor: help;
  }

  /* As tall as a badge, so names and statuses line up and every row has one height */
  .name,
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
  }

  .name {
    gap: 8px;
  }

  /* Differs from local: a translucent logo yellow behind theme-colored text */
  .drift {
    --vscode-badge-background: color-mix(
      in srgb,
      var(--at-warning) var(--at-fill),
      transparent
    );
    --vscode-badge-foreground: var(--at-text);

    /* High contrast has no fills, so an outline carries the color there */
    outline: var(--at-outline) solid var(--at-warning);
    outline-offset: -1px;
  }

  .empty {
    padding: 16px 8px;
    color: var(--at-text-muted);
    text-align: center;
    white-space: normal;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 8px 0 0;
    padding: 8px 0 0;
    border-top: 1px solid var(--at-border);
    color: var(--at-text-muted);
    font-size: 12px;
    list-style: none;
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 6px;
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
    color: var(--at-text-muted);
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

  .count {
    margin-left: auto;
    color: var(--at-text-muted);
  }
`;
