/**
 * Background PDF-fetch outcome notices.
 *
 * The post-import PDF pass (zoteroGateway → publisherPdfResolver) runs
 * fire-and-forget, so its result arrives long after the tool receipt. This
 * module is the bridge: the service layer calls `notifyPdfFetchOutcome`, and
 * every panel that registered its top-toast element shows a short result
 * popup. Same dependency-inversion shape as itemChangeBus — the agent
 * service must not import panel code directly.
 */

import { createTopToastShower, type TopToastShower } from "./topToast";

export interface PdfFetchOutcome {
  /** Items the pass actually tried (no PDF attached at import time). */
  attemptedTitles: string[];
  /** Items that ended up with a PDF (built-in lookup or publisher chain). */
  attachedTitles: string[];
}

const MAX_LISTED_TITLES = 2;
const MAX_TITLE_LENGTH = 48;

const registeredToasts = new Map<HTMLElement, TopToastShower>();

/** Register a panel's top-toast element; re-registering replaces the driver. */
export function registerPdfFetchOutcomeToast(topToast: HTMLElement): void {
  registeredToasts.set(topToast, createTopToastShower(topToast));
}

function shortenTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > MAX_TITLE_LENGTH
    ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : trimmed;
}

function listTitles(titles: string[]): string {
  const listed = titles.slice(0, MAX_LISTED_TITLES).map(shortenTitle);
  const rest = titles.length - listed.length;
  return rest > 0 ? `${listed.join(", ")} (+${rest} more)` : listed.join(", ");
}

/** Compose the one-line toast message; exported for unit tests. */
export function composePdfFetchNoticeMessage(outcome: PdfFetchOutcome): string {
  const { attemptedTitles, attachedTitles } = outcome;
  if (!attemptedTitles.length) return "";
  const failedTitles = attemptedTitles.filter(
    (title) => !attachedTitles.includes(title),
  );
  if (!failedTitles.length) {
    return `PDF downloaded: ${listTitles(attachedTitles)}`;
  }
  if (!attachedTitles.length) {
    return `PDF download failed: ${listTitles(failedTitles)}`;
  }
  return `PDF ${attachedTitles.length}/${attemptedTitles.length} downloaded · failed: ${listTitles(failedTitles)}`;
}

/** Test seam: the last composed notice message, for real-machine probes. */
export function getLastPdfFetchNoticeForTests(): string | null {
  return lastNoticeForTests;
}

let lastNoticeForTests: string | null = null;

/** Show the outcome toast on every registered panel. Never throws. */
export function notifyPdfFetchOutcome(outcome: PdfFetchOutcome): void {
  const message = composePdfFetchNoticeMessage(outcome);
  if (!message) return;
  lastNoticeForTests = message;
  for (const show of registeredToasts.values()) {
    try {
      show(message);
    } catch {
      // A failing panel must never break the background pass.
    }
  }
}
