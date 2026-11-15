// Tooltips that the dashboard draws itself: VS Code webviews do not show
// native title tooltips reliably, at least on macOS. An element names its
// tooltip in data-tooltip; it shows on hover and on keyboard focus.

const showDelay = 300;
const hideDelay = 100;

/** Returns the element with a tooltip that an event passed through, if any. */
function anchorOf(event: Event): HTMLElement | undefined {
  return event
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset.tooltip !== undefined,
    );
}

/**
 * Shows the tooltips of the elements in the shadow root of `host` in the
 * element that `tip` returns. Returns a function for after each render, which
 * hides a tooltip whose element is gone.
 */
export function tooltips(
  host: HTMLElement,
  tip: () => HTMLElement | null,
): () => void {
  let anchor: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // While a timer runs: the anchor it sets, undefined for hiding
  let pending: { target?: HTMLElement } | undefined;

  const hide = () => {
    clearTimeout(timer);
    pending = undefined;
    anchor = undefined;
    const element = tip();
    if (element) element.hidden = true;
  };
  const show = (target: HTMLElement) => {
    clearTimeout(timer);
    pending = undefined;
    const element = tip();
    if (!element || !target.isConnected) return hide();
    anchor = target;
    element.textContent = target.dataset.tooltip ?? '';
    element.hidden = false;
    // Measured at the top left, where the window does not narrow it
    element.style.top = '0px';
    element.style.left = '0px';
    // Below the element, above it near the bottom, always inside the window
    const box = target.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const below = box.bottom + 4;
    const top = below + height > innerHeight - 8 ? box.top - 4 - height : below;
    const left = box.left + box.width / 2 - width / 2;
    element.style.top = `${Math.max(8, top)}px`;
    element.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  };
  /** Moves towards the tooltip of `target`: shown after a pause, hidden shortly after leaving. */
  const settle = (target: HTMLElement | undefined) => {
    if (target === (pending ? pending.target : anchor)) return;
    clearTimeout(timer);
    pending = { target };
    // From one tooltip to the next, the next shows at once
    const delay = target ? (anchor ? 0 : showDelay) : hideDelay;
    timer = setTimeout(() => (target ? show(target) : hide()), delay);
  };

  // Inside the shadow root: events between two of its elements, such as
  // focusout and pointerover, never reach the host
  const root = host.shadowRoot ?? host;
  root.addEventListener('pointermove', event => {
    const element = tip();
    // On the tooltip itself, it stays, for example to be read magnified
    settle(
      element && event.composedPath().includes(element)
        ? anchor
        : anchorOf(event),
    );
  });
  host.addEventListener('pointerleave', () => settle(undefined));
  root.addEventListener('pointerdown', hide);
  root.addEventListener('focusin', event => {
    const target = anchorOf(event);
    if (target?.matches(':focus-visible')) show(target);
  });
  root.addEventListener('focusout', hide);
  root.addEventListener('keydown', event => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') hide();
  });
  addEventListener('scroll', hide, true);
  return () => {
    if (anchor && !anchor.isConnected) hide();
  };
}
