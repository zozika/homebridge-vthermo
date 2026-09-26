/**
 * Per-node traffic control for the Matter controller.
 *
 * - Operations for the same node run one after another, so the controller never has two
 *   exchanges open on one session ("previous message has not been acked yet").
 * - Every operation gets a hard timeout instead of waiting for matter.js' ~55s MRP give-up.
 * - After a failure the node is put into a growing backoff window. While the window is open,
 *   new operations fail immediately instead of queueing behind another long timeout.
 */

export class NodeUnavailableError extends Error {
  constructor(
    readonly nodeId: string,
    readonly retryInMs: number,
    readonly lastError: string,
    readonly cause?: unknown,
  ) {
    // Keep the message stable across retries so callers can log it once instead of every cycle.
    super(`Matter node ${nodeId} is not reachable: ${lastError}`);
    this.name = "NodeUnavailableError";
  }
}

export class OperationTimeoutError extends Error {
  constructor(description: string, timeoutMs: number) {
    super(`Timed out after ${Math.round(timeoutMs / 1000)}s while ${description}.`);
    this.name = "OperationTimeoutError";
  }
}

export interface NodeHealth {
  consecutiveFailures: number;
  blockedUntil: number;
  lastError?: string;
  lastSuccessAt?: number;
}

export interface NodeGuardOptions {
  timeoutMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  now?: () => number;
  onStateChange?: (nodeId: string, online: boolean, detail?: string) => void;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(description, timeoutMs)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class NodeGuard {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly health = new Map<string, NodeHealth>();
  private readonly now: () => number;

  constructor(private readonly options: NodeGuardOptions) {
    this.now = options.now ?? Date.now;
  }

  getHealth(nodeId: string): NodeHealth {
    let entry = this.health.get(nodeId);
    if (!entry) {
      entry = { consecutiveFailures: 0, blockedUntil: 0 };
      this.health.set(nodeId, entry);
    }

    return entry;
  }

  isBlocked(nodeId: string): boolean {
    return this.getHealth(nodeId).blockedUntil > this.now();
  }

  /** Forget the backoff for a node, e.g. after its address was changed by the user. */
  reset(nodeId: string): void {
    const entry = this.getHealth(nodeId);
    entry.blockedUntil = 0;
    entry.consecutiveFailures = 0;
  }

  run<T>(nodeId: string, description: string, action: () => Promise<T>, timeoutMs = this.options.timeoutMs): Promise<T> {
    const previous = this.queues.get(nodeId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(nodeId, description, action, timeoutMs));

    this.queues.set(nodeId, next);
    void next.catch(() => undefined).finally(() => {
      if (this.queues.get(nodeId) === next) {
        this.queues.delete(nodeId);
      }
    });

    return next;
  }

  private async execute<T>(nodeId: string, description: string, action: () => Promise<T>, timeoutMs: number): Promise<T> {
    const entry = this.getHealth(nodeId);
    const now = this.now();

    if (entry.blockedUntil > now) {
      throw new NodeUnavailableError(nodeId, entry.blockedUntil - now, entry.lastError ?? "unknown error");
    }

    try {
      const result = await withTimeout(action(), timeoutMs, description);
      const wasOffline = entry.consecutiveFailures > 0;
      entry.consecutiveFailures = 0;
      entry.blockedUntil = 0;
      entry.lastError = undefined;
      entry.lastSuccessAt = this.now();
      if (wasOffline) {
        this.options.onStateChange?.(nodeId, true);
      }
      return result;
    } catch (error) {
      if (this.isNodeLevelFailure(error)) {
        entry.consecutiveFailures += 1;
        entry.lastError = (error instanceof Error ? error.message : String(error)).trim().replace(/\.+$/, "");
        const backoff = Math.min(
          this.options.baseBackoffMs * 2 ** (entry.consecutiveFailures - 1),
          this.options.maxBackoffMs,
        );
        entry.blockedUntil = this.now() + backoff;
        if (entry.consecutiveFailures === 1) {
          this.options.onStateChange?.(nodeId, false, entry.lastError);
        }

        // Same error shape whether this was the failing attempt or a fast-failed one during backoff.
        throw new NodeUnavailableError(nodeId, backoff, entry.lastError, error);
      }

      throw error;
    }
  }

  /**
   * Only connectivity problems open the circuit. A clean protocol answer such as
   * "unsupported attribute" proves the node is alive.
   */
  private isNodeLevelFailure(error: unknown): boolean {
    if (error instanceof OperationTimeoutError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /timed out|timeout|not reachable|unreachable|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|not been acked|Session ended|closed|discover/i
      .test(message);
  }
}
