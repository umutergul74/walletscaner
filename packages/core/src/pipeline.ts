import type { NormalizedEvent, Signal } from "@memecoin-alpha/shared";
import { generateSignal } from "./signal-generator";
import type { SignalInput } from "./signal-generator";

export interface ProcessedEventResult {
  accepted: NormalizedEvent[];
  rejected: Array<{ event: NormalizedEvent; reason: string }>;
}

export function dedupeEvents(events: NormalizedEvent[]): ProcessedEventResult {
  const seen = new Set<string>();
  const accepted: NormalizedEvent[] = [];
  const rejected: Array<{ event: NormalizedEvent; reason: string }> = [];

  for (const event of events) {
    if (seen.has(event.idempotencyKey)) {
      rejected.push({ event, reason: "duplicate idempotency key" });
      continue;
    }

    seen.add(event.idempotencyKey);
    accepted.push(event);
  }

  return { accepted, rejected };
}

export function generateSignalsFromInputs(inputs: SignalInput[]): Signal[] {
  return inputs.map((input) => generateSignal(input));
}

