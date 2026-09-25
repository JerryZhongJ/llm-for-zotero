/**
 * Shared driver for the `#llm-top-toast` status element each panel header
 * owns. One toast per panel element; the shower is self-contained (timers
 * run on the element's own window so a torn-down panel stops itself).
 */

export type TopToastShower = (message: string) => void;

const TOP_TOAST_TIMEOUT_MS = 2600;

export function createTopToastShower(
  topToast: HTMLElement | null,
): TopToastShower {
  if (!topToast) return () => undefined;
  let timer: number | null = null;

  const getWindow = (): (Window & typeof globalThis) | null =>
    topToast.ownerDocument?.defaultView ?? null;

  return (message: string): void => {
    const win = getWindow();
    if (timer !== null) {
      (win ?? globalThis).clearTimeout(timer as never);
      timer = null;
    }
    topToast.textContent = message;
    topToast.style.display = "flex";
    topToast.setAttribute("aria-hidden", "false");
    const reveal = () => topToast.classList.add("llm-top-toast-visible");
    if (win?.requestAnimationFrame) {
      win.requestAnimationFrame(reveal);
    } else {
      reveal();
    }
    timer = (win ?? globalThis).setTimeout(() => {
      topToast.classList.remove("llm-top-toast-visible");
      topToast.setAttribute("aria-hidden", "true");
      topToast.style.display = "none";
      timer = null;
    }, TOP_TOAST_TIMEOUT_MS) as unknown as number;
  };
}
