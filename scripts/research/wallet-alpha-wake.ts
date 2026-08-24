export interface WalletAlphaWakePayload {
  strategyVersion: string;
  priority: number;
}

/** PostgreSQL NOTIFY is a wake hint only; malformed or background-only hints are ignored. */
export function parseWalletAlphaWake(
  payload: string | undefined,
  strategyVersion: string
): WalletAlphaWakePayload | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as Partial<WalletAlphaWakePayload>;
    if (
      parsed.strategyVersion !== strategyVersion ||
      !Number.isInteger(parsed.priority) ||
      Number(parsed.priority) < 1 ||
      Number(parsed.priority) > 2
    ) {
      return undefined;
    }
    return {
      strategyVersion: parsed.strategyVersion,
      priority: Number(parsed.priority)
    };
  } catch {
    return undefined;
  }
}

/**
 * Coalesces notification bursts without losing a notification that arrives
 * between a processing cycle and registration of the next wait.
 */
export class CoalescingWakeSignal {
  private pending = false;
  private waiter: (() => void) | undefined;

  signal(): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter();
      return;
    }
    this.pending = true;
  }

  async wait(timeoutMs: number): Promise<"signal" | "timeout"> {
    if (this.pending) {
      this.pending = false;
      return "signal";
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.waiter = undefined;
          resolve("timeout");
        },
        Math.max(1, timeoutMs)
      );
      this.waiter = () => {
        clearTimeout(timer);
        this.pending = false;
        resolve("signal");
      };
    });
  }
}

export function walletAlphaPollDelayMs(
  pendingWallets: number,
  backlogSeconds: number,
  idleSeconds: number
): number {
  return Math.max(1, pendingWallets > 0 ? backlogSeconds : idleSeconds) * 1_000;
}
