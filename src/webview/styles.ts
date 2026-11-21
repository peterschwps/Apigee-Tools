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

  /*
   * Type scale: 22 px for the page title, 18 px for the title of the details,
   * 14 px for tabs, field labels, and card titles, 13 px for content. One
   * bold weight, 600, which tabs, headings, and column names share.
   */
  h1,
  h2,
  h3 {
    margin: 0;
    font-weight: 600;
  }

  h1 {
    font-size: 22px;
    white-space: nowrap;
  }

  h2,
  h3 {
    font-size: 14px;
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
    gap: 18px 24px;
    padding: 20px 20px 0;
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
    gap: 6px;
    min-width: 0;
  }

  /* The label above its dropdown, bold as vscode-label draws it */
  .field {
    display: grid;
    gap: 4px;
  }

  /* A size above the dropdown's, so the label leads */
  .field-label {
    color: var(--at-text);
    font-size: 14px;
  }

  /* Wide enough for 30-character project IDs; the option list copies the width */
  #organization,
  #environment {
    width: 250px;
    max-width: 100%;
  }

  /* Only the icon, which the tooltip names; a line sets it apart from Refresh */
  .account {
    display: flex;
    padding-right: 8px;
    border-right: 1px solid var(--at-border);
    color: var(--at-text-muted);
  }

  /* Without Refresh, while the first load runs, no line */
  .account:last-child {
    padding-right: 0;
    border-right: 0;
  }

  /* Refresh in the account's gray; hover brings the full icon color */
  .session .refresh {
    color: var(--at-text-muted);
  }

  .account vscode-icon,
  .refresh vscode-icon {
    color: inherit;
  }

  /* Tabs */
  vscode-tabs {
    padding: 0 20px;
  }

  /* Space sets the page tabs apart from the header above them */
  :host > vscode-tabs {
    margin-top: 28px;
  }

  .card vscode-tabs {
    padding: 0;
  }

  /* A 2px active indicator; the header's own underline is only 1px */
  vscode-tab-header[active] {
    box-shadow: inset 0 -2px 0 var(--vscode-panelTitle-activeForeground);
  }

  /* Every tab in bold, so the active one does not change the width */
  .tab-label {
    color: var(--vscode-panelTitle-inactiveForeground);
    font-size: 14px;
    font-weight: 600;
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
    padding: 20px 20px 0;
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

  /* Only beside the first line: empty rows would add their gaps below the text */
  .notice > vscode-icon {
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

  .item-name {
    font-weight: 600;
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

  /*
   * vscode-icon sets the icon color itself; here it follows the button. Only
   * the button's icon: the state icons in the filter menu keep their colors
   */
  .column-head .icon-button vscode-icon {
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

  /* Chosen states in gray, as VS Code shows a selection in an unfocused list */
  .menu-item[aria-checked='true'] {
    outline: 1px solid var(--vscode-contrastActiveBorder, transparent);
    outline-offset: -1px;
    background: var(--vscode-list-inactiveSelectionBackground);
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
    font-size: 18px;
    overflow-wrap: anywhere;
  }

  .details-actions {
    display: flex;
    gap: 4px;
    margin-left: auto;
  }

  /* Relationships: the graph, and the details beside it on wide windows */
  .relations {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
    align-items: start;
    gap: 16px;
  }

  @media (max-width: 1400px) {
    .relations {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .graph-scroll {
    overflow-x: auto;
  }

  /* Five columns with gaps for the edges; the gaps match the graph module */
  .graph {
    display: grid;
    grid-template-columns: repeat(4, minmax(110px, 1fr) 40px) minmax(
        110px,
        1fr
      );
    align-items: start;
    min-width: 710px;
  }

  .column-title {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    margin-bottom: 8px;
    white-space: nowrap;
  }

  .column-title span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .graph-column ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* One row per node, as tall as the pitch of the graph module */
  .graph-column li {
    display: flex;
    align-items: center;
    height: 28px;
  }

  /* The edges start below the column titles */
  .gutter {
    padding-top: 32px;
  }

  .gutter svg {
    display: block;
    overflow: visible;
  }

  .node {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--at-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .node:hover {
    background: var(--vscode-list-hoverBackground);
  }

  /* The name stands out under the pointer */
  .node:hover .node-name {
    font-weight: 600;
  }

  .node:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .node.match {
    border-color: var(--vscode-focusBorder);
  }

  .node[aria-current='true'] {
    border-color: var(--vscode-focusBorder);
    background: var(
      --vscode-list-inactiveSelectionBackground,
      var(--vscode-list-hoverBackground)
    );
  }

  .node vscode-icon {
    flex: none;
  }

  /* vscode-icon sets the icon color itself; flow hook and pin marks stay muted */
  .node .hook,
  .node .pin {
    color: var(--at-text-muted);
  }

  .node-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more {
    padding: 0 6px;
    color: var(--at-text-muted);
  }

  /* Status colors only for lines here too: waiting dashed, revoked dotted */
  .edge {
    fill: none;
    stroke: var(--at-text-muted);
    stroke-opacity: 0.6;
  }

  .edge.pending {
    stroke: var(--at-warning);
    stroke-opacity: 1;
    stroke-dasharray: 4 3;
  }

  .edge.revoked {
    stroke: var(--at-error);
    stroke-opacity: 1;
    stroke-dasharray: 1 3;
  }

  .edge.hook {
    stroke-dasharray: 6 3;
  }

  .side {
    display: grid;
    gap: 8px;
    overflow-wrap: anywhere;
  }

  .side-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .group-title {
    margin: 8px 0 0;
    font-size: 13px;
    font-weight: 600;
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 12px;
    margin: 0;
  }

  .facts dt {
    color: var(--at-text-muted);
  }

  .facts dd {
    margin: 0;
  }

  .relation-list {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .relation-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
  }

  /* Texts after a name stay beside it while there is room, and wrap there */
  .relation-list li > .muted,
  .relation-list .fill {
    flex: 1 1 10em;
    min-width: 0;
  }

  .side .icon-button.labeled {
    justify-self: start;
  }

  .hint {
    margin-top: 4px;
  }

  /*
   * Flow view. The DOM lists the stages in run order. Narrow panels show it
   * as a rail from top to bottom; from 1000 px, Apigee's bands: the request
   * from left to right, the response below it from right to left.
   */
  /* The bundle's name with its kind and path below */
  .flow-brand {
    flex-direction: column;
    align-items: start;
    gap: 4px;
    min-width: 0;
  }

  /* Back and Forward in the corner; the icons line up with the title */
  .history {
    display: flex;
    gap: 2px;
    margin-left: -3px;
  }

  .icon-button:disabled {
    background: none;
    border-color: transparent;
    opacity: 0.4;
    cursor: default;
  }

  .flow-brand h1 {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .flow-path {
    overflow-wrap: anywhere;
  }

  /* The source with the status of its deployment and its difference */
  .source {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #source {
    width: 250px;
    max-width: 100%;
  }

  .sign {
    display: inline-flex;
  }

  .context .loading {
    padding: 0;
  }

  .session .fold {
    color: var(--at-text-muted);
  }

  .fold vscode-icon {
    color: inherit;
  }

  .hook-mark {
    margin-right: 2px;
    color: var(--at-text-muted);
  }

  /* Map and list stay readable in wide tabs */
  .flow-maps {
    box-sizing: border-box;
    display: grid;
    gap: 28px;
    max-width: 960px;
    padding: 16px 20px 28px;
  }

  .flow-map {
    display: grid;
    align-content: start;
    gap: 10px;
    min-width: 0;
  }

  /* The map stays at the top while the list of its endpoint scrolls by */
  .overview {
    position: sticky;
    top: 0;
    z-index: 1;
    margin: 0 -20px;
    padding: 8px 20px;
    border-bottom: 1px solid var(--at-border);
    background: var(--vscode-editor-background);
  }

  .stations {
    display: grid;
    grid-auto-rows: 26px;
    row-gap: 6px;
    align-items: center;
  }

  .row-mark {
    display: flex;
    align-items: center;
  }

  .row-mark vscode-icon {
    color: var(--at-text-muted);
  }

  /* A line runs through the stations of the request and the response */
  .slot {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 100%;
  }

  .slot.through {
    background: linear-gradient(var(--at-border), var(--at-border)) center /
      100% 1px no-repeat;
  }

  .slot.from {
    background: linear-gradient(var(--at-border), var(--at-border)) right
      center / 50% 1px no-repeat;
  }

  .slot.to {
    background: linear-gradient(var(--at-border), var(--at-border)) left
      center / 50% 1px no-repeat;
  }

  /* Where the request turns: the backend, or a route without a target */
  .turn {
    display: flex;
    align-self: stretch;
    min-width: 0;
  }

  /* Stations look like the nodes of the Relationships graph */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: calc(100% - 8px);
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--at-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .turn .chip {
    flex: 1;
    justify-content: center;
    max-width: none;
    height: 100%;
  }

  .chip:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .chip:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .chip.empty {
    border-style: dashed;
    color: var(--at-text-muted);
  }

  /* The station whose part of the list is in sight */
  .chip[aria-current] {
    border-color: var(--vscode-focusBorder);
    background: var(
      --vscode-list-inactiveSelectionBackground,
      var(--vscode-list-hoverBackground)
    );
  }

  .chip-icon {
    flex: none;
    color: var(--at-text-muted);
  }

  .chip-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The list: rows like the ones of VS Code's trees */
  .tree {
    display: grid;
    min-width: 0;
  }

  .row {
    position: relative;
    display: flex;
    align-items: flex-start;
    min-width: 0;
    padding: 2px 0;
  }

  .row:focus {
    outline: none;
  }

  .row.active {
    cursor: pointer;
  }

  .row.band {
    margin-top: 18px;
  }

  .row.band:first-child {
    margin-top: 0;
  }

  .row.station {
    padding-top: 10px;
  }

  .level-2 {
    padding-left: 22px;
  }

  .level-3 {
    padding-left: 42px;
  }

  .level-4 {
    padding-left: 62px;
  }

  .level-5 {
    padding-left: 82px;
  }

  .twisty {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 24px;
  }

  .twisty vscode-icon {
    cursor: pointer;
  }

  /* What a row says; hover, focus, and the marks draw around it */
  .label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    min-height: 24px;
    padding: 0 6px;
    border: 1px solid transparent;
    border-radius: 4px;
  }

  .row.active:hover > .label,
  .row.active:hover .pill {
    background: var(--vscode-list-hoverBackground);
  }

  .row:focus-visible > .label,
  .row:focus-visible .pill {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* The row whose file was opened last, and the route the view follows */
  .row[aria-selected='true'] > .label,
  .row[aria-selected='true'] .pill,
  .row[aria-current='true'] > .label {
    border-color: var(--vscode-focusBorder);
    background: var(
      --vscode-list-inactiveSelectionBackground,
      var(--vscode-list-hoverBackground)
    );
  }

  .band-title {
    font-size: 14px;
    font-weight: 600;
  }

  .band-title vscode-icon {
    color: var(--at-text-muted);
  }

  .station-name {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .segment-label {
    color: var(--at-text-muted);
  }

  .fact {
    margin-left: 26px;
    color: var(--at-text-muted);
  }

  .label .number,
  .label .summary,
  .label .destination,
  .label.muted .case-name {
    color: var(--at-text-muted);
  }

  .label .number {
    min-width: 1ch;
    font-variant-numeric: tabular-nums;
  }

  .case-name {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Conditions and destinations give way before the name */
  .label .summary,
  .label .destination {
    flex: 0 100 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A step: its policy as a pill, with its condition below */
  .step-box {
    display: grid;
    justify-items: start;
    min-width: 0;
    max-width: 100%;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--at-border);
    border-radius: 4px;
    background: var(--vscode-editor-background);
    white-space: nowrap;
  }

  .pill.conditional {
    border-style: dashed;
  }

  .pill.muted .pill-name {
    color: var(--at-text-muted);
  }

  .pill-name {
    flex: none;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The name stands out under the pointer, as in the Relationships graph */
  .row.step:hover .pill-name {
    font-weight: 600;
  }

  /* The type gives way first when a step runs out of room */
  .pill .type {
    flex: 0 100 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--at-text-muted);
    text-overflow: ellipsis;
  }

  .condition {
    max-width: 100%;
    padding: 0 0 4px 7px;
    overflow: hidden;
    color: var(--at-text-muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The stations of a band hang on a line: shapes, never read aloud */
  .rail-first::before,
  .rail-middle::before,
  .rail-last::before,
  .rail-through::before {
    content: '';
    position: absolute;
    left: 7px;
    border-left: 1px solid var(--at-border);
  }

  .rail-first::before {
    top: 22px;
    bottom: 0;
  }

  .rail-middle::before,
  .rail-through::before {
    top: 0;
    bottom: 0;
  }

  .rail-last::before {
    top: 0;
    height: 22px;
  }

  .mark-circle::after,
  .mark-diamond::after,
  .mark-square::after {
    content: '';
    position: absolute;
    top: 18px;
    left: 3px;
    width: 9px;
    height: 9px;
    box-sizing: border-box;
    border: 1px solid var(--at-text-muted);
    background: var(--vscode-editor-background);
  }

  .mark-circle::after {
    border-radius: 50%;
  }

  .mark-diamond::after {
    transform: rotate(45deg);
  }
`;
