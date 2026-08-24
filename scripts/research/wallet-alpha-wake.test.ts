import { describe, expect, it } from "vitest";
import {
  CoalescingWakeSignal,
  parseWalletAlphaWake,
  walletAlphaPollDelayMs
} from "./wallet-alpha-wake";

describe("wallet-alpha wake scheduling", () => {
  it("accepts only elevated notifications for the active strategy", () => {
    expect(
      parseWalletAlphaWake('{"strategyVersion":"evidence-v1","priority":2}', "evidence-v1")
    ).toEqual({ strategyVersion: "evidence-v1", priority: 2 });
    expect(
      parseWalletAlphaWake('{"strategyVersion":"evidence-v1","priority":0}', "evidence-v1")
    ).toBeUndefined();
    expect(
      parseWalletAlphaWake('{"strategyVersion":"other","priority":2}', "evidence-v1")
    ).toBeUndefined();
    expect(parseWalletAlphaWake("not-json", "evidence-v1")).toBeUndefined();
  });

  it("does not lose a signal delivered before the wait starts", async () => {
    const wake = new CoalescingWakeSignal();
    wake.signal();
    await expect(wake.wait(10_000)).resolves.toBe("signal");
  });

  it("uses a shorter bounded fallback while backlog remains", () => {
    expect(walletAlphaPollDelayMs(1, 30, 300)).toBe(30_000);
    expect(walletAlphaPollDelayMs(0, 30, 300)).toBe(300_000);
  });
});
