type Rect = Pick<DOMRectReadOnly, "left" | "right" | "width" | "height">;

export function computeReaderPanelInsets(input: {
  hostRect: Rect;
  frameRect?: Rect;
  viewRect?: Rect;
  splitterRect?: Rect;
  fallbackLeft: number;
  /** The viewRect was measured from live reader DOM (not reader state):
   *  trust it even when it says the inset is zero, so a stale state-based
   *  fallbackLeft cannot keep the panel inset after the sidebar closes. */
  trusted?: boolean;
}): { left: number; right: number } {
  const { hostRect, frameRect, viewRect, splitterRect, fallbackLeft } = input;
  let left = fallbackLeft;
  let rightEdge = hostRect.right;
  if (viewRect && frameRect && viewRect.width > 0 && frameRect.width > 0) {
    const viewLeft = frameRect.left + viewRect.left - hostRect.left;
    if (input.trusted) left = Math.max(0, viewLeft);
    else if (viewLeft > 0) left = viewLeft;
    rightEdge = Math.min(rightEdge, frameRect.left + viewRect.right);
  }
  if (
    splitterRect &&
    splitterRect.width > 0 &&
    splitterRect.height > 0 &&
    splitterRect.left > hostRect.left &&
    splitterRect.left < hostRect.right
  ) {
    rightEdge = Math.min(rightEdge, splitterRect.left);
  }
  const right = hostRect.right - rightEdge;
  if (
    ![left, right, hostRect.width].every(Number.isFinite) ||
    hostRect.width <= 0 ||
    left < 0 ||
    right < 0 ||
    left + right >= hostRect.width
  ) {
    return { left: fallbackLeft, right: 0 };
  }
  return { left: Math.round(left), right: Math.round(right) };
}
