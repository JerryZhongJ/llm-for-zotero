/**
 * MinerU parse button for the paper chat panel header.
 *
 * Paper conversations frequently target PDFs that were never parsed by
 * MinerU, so their sections only match via the reader-outline index (or the
 * canonical chunk labels). This button runs the shared single-item MinerU
 * pipeline from the panel itself; once a cache exists the spot turns into a
 * quiet "MinerU Parsed" status label. The button renders only when MinerU
 * is enabled and the conversation resolves to a PDF attachment — library
 * chats and note sessions never see it.
 */

import { isMineruEnabled } from "../../utils/mineruConfig";
import { t } from "../../utils/i18n";
import {
  getMineruBatchState,
  onBatchStateChange,
  processSelectedItems,
} from "../mineruBatchProcessor";
import { hasCachedMineruMd } from "./mineruCache";
import { isPdfContextAttachment } from "./contextAttachmentSupport";
import { getFirstPdfChildAttachment } from "./contextResolution";
import {
  resolveActiveNoteSession,
  resolveDisplayConversationKind,
} from "./portalScope";

type MineruButtonState = "checking" | "idle" | "running" | "done";

const TOP_TOAST_TIMEOUT_MS = 6000;

function renderMineruButton(
  button: HTMLButtonElement,
  state: MineruButtonState,
  detail = "",
): void {
  button.dataset.mineruState = state;
  if (state === "done") {
    button.textContent = t("MinerU Parsed");
    button.title = t("This paper has been parsed with MinerU");
    button.disabled = true;
    return;
  }
  if (state === "running") {
    button.textContent = t("Parsing…");
    button.title = detail || t("Parsing this paper with MinerU");
    button.disabled = true;
    return;
  }
  if (state === "checking") {
    button.textContent = "MinerU…";
    button.title = "";
    button.disabled = true;
    return;
  }
  button.textContent = "MinerU";
  // A failure detail (or an already-running batch) survives as the tooltip
  // of the re-enabled button so the reason stays one hover away.
  button.title = detail || t("Parse this paper with MinerU");
  button.disabled = false;
}

// Same reveal/auto-hide dance the history lifecycle controller uses for
// #llm-top-toast; failure reasons must be seen, not hunted for in a tooltip.
function showPanelToast(button: HTMLButtonElement, message: string): void {
  const toast = button.closest(".llm-panel")?.querySelector("#llm-top-toast");
  if (!(toast instanceof HTMLElement)) return;
  const win = button.ownerDocument?.defaultView;
  toast.textContent = message;
  toast.style.display = "flex";
  toast.setAttribute("aria-hidden", "false");
  const reveal = () => toast.classList.add("llm-top-toast-visible");
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(reveal);
  } else {
    reveal();
  }
  win?.setTimeout(() => {
    toast.classList.remove("llm-top-toast-visible");
    toast.setAttribute("aria-hidden", "true");
    toast.style.display = "none";
  }, TOP_TOAST_TIMEOUT_MS);
}

function describeMineruFailure(message: string): string {
  if (/\bHTTP 40[13]\b/.test(message)) {
    return t(
      "MinerU authentication failed — check the API key in Settings",
    ).concat(" (", message, ")");
  }
  return message;
}

export function attachMineruParseButton(
  panel: Element,
  item: Zotero.Item | null | undefined,
): void {
  if (!item || !isMineruEnabled()) return;
  // Notes and library chats have no PDF to parse.
  if (resolveActiveNoteSession(item)) return;
  if (resolveDisplayConversationKind(item) !== "paper") return;
  const pdfItem = isPdfContextAttachment(item)
    ? item
    : getFirstPdfChildAttachment(item);
  if (!pdfItem) return;
  const actions = panel.querySelector(".llm-header-actions");
  if (!actions || actions.querySelector(".llm-mineru-btn")) return;

  const doc = panel.ownerDocument!;
  const button = doc.createElement("button") as HTMLButtonElement;
  button.className = "llm-mineru-btn";
  button.type = "button";
  renderMineruButton(button, "checking");
  // Leading position: the state label reads as paper metadata, not an
  // action, once parsing has happened.
  actions.prepend(button);

  let current: MineruButtonState = "checking";
  const render = (state: MineruButtonState, detail = "") => {
    current = state;
    renderMineruButton(button, state, detail);
  };

  const refreshCacheState = async () => {
    try {
      const cached = await hasCachedMineruMd(pdfItem.id);
      if (!button.isConnected || current === "running") return;
      render(cached ? "done" : "idle");
    } catch {
      if (button.isConnected && current !== "running") render("idle");
    }
  };
  void refreshCacheState();

  button.addEventListener("click", () => {
    if (current === "done" || current === "running") return;
    const batch = getMineruBatchState();
    if (batch.running && batch.currentItemId !== pdfItem.id) {
      render("idle", t("A MinerU batch is already running"));
      return;
    }
    render("running");
    void processSelectedItems([pdfItem.id], { overrideEligibility: true });
  });

  const unsubscribe = onBatchStateChange((state) => {
    // The panel DOM owns the button; when it goes, so does this listener.
    if (!button.isConnected) {
      unsubscribe();
      return;
    }
    if (state.running && state.currentItemId === pdfItem.id) {
      if (current !== "running") render("running", state.statusMessage);
      else button.title = state.statusMessage || button.title;
      return;
    }
    if (current !== "running") return;
    // Our item left the running slot: success flips to the parsed label,
    // failure re-enables the button and announces the reason via the
    // panel toast (a bare tooltip hid the 401 for too long).
    if (state.lastFailedItemId === pdfItem.id && state.lastFailedMessage) {
      render("idle", state.lastFailedMessage);
      showPanelToast(button, describeMineruFailure(state.lastFailedMessage));
      return;
    }
    // Leave "running" BEFORE the async cache check — refreshCacheState
    // refuses to overwrite a running state, so the button would otherwise
    // stay on the last stage message ("Done…") forever.
    render("checking");
    void refreshCacheState();
  });
}
