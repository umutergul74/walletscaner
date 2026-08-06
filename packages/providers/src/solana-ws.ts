export interface LogsSubscribeRequest {
  jsonrpc: "2.0";
  id: number;
  method: "logsSubscribe";
  params: [
    "all" | "allWithVotes" | { mentions: [string] },
    {
      commitment: "processed" | "confirmed" | "finalized";
    }
  ];
}

export function createLogsSubscribeRequest(
  id: number,
  mentionsAddress: string | "all" | "allWithVotes",
  commitment: "processed" | "confirmed" | "finalized" = "finalized"
): LogsSubscribeRequest {
  const filter =
    mentionsAddress === "all" || mentionsAddress === "allWithVotes"
      ? mentionsAddress
      : { mentions: [mentionsAddress] as [string] };

  return {
    jsonrpc: "2.0",
    id,
    method: "logsSubscribe",
    params: [filter, { commitment }]
  };
}

