export function dedupeSignalsByToken<T extends { tokenAddress: string; signalAt: string }>(
  signals: T[]
): T[] {
  const byToken = new Map<string, T>();
  for (const signal of signals) {
    const existing = byToken.get(signal.tokenAddress);
    if (!existing || new Date(signal.signalAt).getTime() < new Date(existing.signalAt).getTime()) {
      byToken.set(signal.tokenAddress, signal);
    }
  }
  return [...byToken.values()];
}
