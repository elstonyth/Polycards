/**
 * Keeps React alive under browser page translation (Chrome/Google Translate,
 * Edge, Safari). Translation swaps each text node for its own <font> wrapper,
 * so the text node React still holds is no longer in the page. The next time
 * React inserts something before that node, or removes it, the DOM throws
 * NotFoundError and the nearest error boundary replaces the screen with
 * "Something went wrong" (2026-10-18: a Chinese-translated customer tapped
 * "Confirm real name" and the real-name gate's spinner insert crashed /me).
 * Any `{busy && <Spinner />}Label` button does the same, so the guard is
 * site-wide rather than per component. Workaround from facebook/react#11538.
 *
 * Only the two calls that throw on a node translation moved are changed, and
 * only in that case; every other call goes straight through.
 */
export function installTranslateDomGuard(): void {
  if (typeof Node !== 'function' || !Node.prototype) return;
  const proto = Node.prototype as Node & { __translateGuard?: true };
  if (proto.__translateGuard) return;
  proto.__translateGuard = true;

  const removeChild = proto.removeChild;
  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    // Already gone from here (translation replaced it): nothing to remove.
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };

  const insertBefore = proto.insertBefore;
  proto.insertBefore = function <T extends Node>(
    this: Node,
    node: T,
    ref: Node | null,
  ): T {
    // The anchor was moved out by translation: append instead, so the new
    // content (a spinner, an error line) still shows, just at the end.
    if (ref && ref.parentNode !== this) {
      return insertBefore.call(this, node, null) as T;
    }
    return insertBefore.call(this, node, ref) as T;
  };
}
