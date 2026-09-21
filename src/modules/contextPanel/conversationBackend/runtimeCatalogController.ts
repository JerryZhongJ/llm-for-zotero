/**
 * The load-state machine behind a runtime's model catalog (Claude bridge,
 * Codex app-server). Both runtimes used to carry hand-rolled copies of the
 * same idle/loading/ready/error dance — in-flight dedupe, request-id
 * guarding against a stale resolve, identity changes dropping the cache —
 * as nine and five loose closure variables respectively. The machine lives
 * here once; each runtime supplies its identity, loader, and UI-refresh
 * hook.
 */

export type RuntimeCatalogStatus = "idle" | "loading" | "ready" | "error";

export type RuntimeCatalogControllerOptions<Snapshot> = {
  /**
   * Cache key: when it changes, the cached snapshot is dropped before the
   * next load (Claude scopes it by bridge URL + conversation scope; Codex by
   * the configured binary path).
   */
  identity: () => string;
  load: (force: boolean) => Promise<Snapshot>;
  /** Called after every terminal state change so open menus re-render. */
  onRefreshUi: () => void;
  /** How long a ready snapshot satisfies loads without a forced refresh. */
  ttlMs?: number;
  /**
   * Whether the in-flight load can satisfy a request with this force flag.
   * Codex always reuses; Claude never lets an unforced in-flight load
   * satisfy a forced one (its data may come from the bridge cache), so it
   * compares both flags.
   */
  canReuseInFlight?: (
    requestedForce: boolean,
    inFlightForce: boolean,
  ) => boolean;
  onSnapshotDropped?: () => void;
  /** Codex drops the model list on error; Claude keeps the last known one. */
  clearSnapshotOnError?: boolean;
  onError: (error: unknown) => void;
  errorLabel: string;
};

export type RuntimeCatalogController<Snapshot> = {
  ensure: (force?: boolean) => Promise<void>;
  reset: () => void;
  getStatus: () => RuntimeCatalogStatus;
  getError: () => string;
  getSnapshot: () => Snapshot | undefined;
};

export function createRuntimeCatalogController<Snapshot>(
  options: RuntimeCatalogControllerOptions<Snapshot>,
): RuntimeCatalogController<Snapshot> {
  const ttlMs = options.ttlMs ?? Number.POSITIVE_INFINITY;
  const canReuseInFlight = options.canReuseInFlight ?? (() => true);
  let status: RuntimeCatalogStatus = "idle";
  let error = "";
  let snapshot: Snapshot | undefined;
  let loadedAt = 0;
  let currentIdentity = "";
  let inFlight: Promise<void> | null = null;
  let inFlightForced = false;
  let requestId = 0;

  const controller: RuntimeCatalogController<Snapshot> = {
    ensure(force = false): Promise<void> {
      const identity = options.identity();
      const identityChanged = identity !== currentIdentity;
      if (
        !force &&
        !identityChanged &&
        status === "ready" &&
        Date.now() - loadedAt < ttlMs
      ) {
        return Promise.resolve();
      }
      if (
        inFlight &&
        !identityChanged &&
        canReuseInFlight(force, inFlightForced)
      ) {
        // Rapid re-opens piggyback on the running fetch instead of launching
        // a parallel one.
        return inFlight;
      }
      if (identityChanged) {
        snapshot = undefined;
        loadedAt = 0;
        options.onSnapshotDropped?.();
      }
      status = "loading";
      error = "";
      currentIdentity = identity;
      inFlightForced = force;
      const request = ++requestId;
      options.onRefreshUi();
      inFlight = options
        .load(force)
        .then((next) => {
          if (request !== requestId || identity !== options.identity()) {
            return;
          }
          snapshot = next;
          status = "ready";
          error = "";
          loadedAt = Date.now();
        })
        .catch((loadError: unknown) => {
          if (request !== requestId || identity !== options.identity()) {
            return;
          }
          status = "error";
          error =
            loadError instanceof Error ? loadError.message : String(loadError);
          if (options.clearSnapshotOnError) snapshot = undefined;
          options.onError(loadError);
        })
        .finally(() => {
          if (request !== requestId) return;
          inFlight = null;
          inFlightForced = false;
          options.onRefreshUi();
        });
      return inFlight;
    },
    reset() {
      requestId += 1;
      inFlight = null;
      inFlightForced = false;
      status = "idle";
      error = "";
    },
    getStatus: () => status,
    getError: () => error,
    getSnapshot: () => snapshot,
  };
  return controller;
}
