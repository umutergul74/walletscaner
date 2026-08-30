/** Credential presence only; never return the supplied value. */
export function quotePricePrerequisite(apiKey: string | undefined) {
  const authenticationConfigured = Boolean(apiKey?.trim());
  return {
    authenticationConfigured,
    ...(authenticationConfigured ? {} : {
      reason: "SOL/USD price evidence blocked: PYTH_API_KEY is not configured"
    })
  };
}
