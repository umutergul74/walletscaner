import { readFileSync } from "node:fs";

const deny = (reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
};

const warn = (message) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: `Walletscaner safety hook: ${message}`,
      },
    }),
  );
};

let event;
try {
  event = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

const toolName = String(event?.tool_name ?? "");
const toolInput = event?.tool_input ?? {};
const command = String(toolInput.command ?? toolInput.cmd ?? "");

if (/^(?:apply_patch|Edit|Write)$/i.test(toolName)) {
  const touchesSecretFile =
    /^\*\*\* (?:Add|Update|Delete) File:\s+.*(?:^|[\\/])\.env(?:\.server)?\s*$/im.test(command) ||
    /^\*\*\* (?:Add|Update|Delete) File:\s+.*(?:credentials?|secrets?)(?:\.[^\\/\s]+)?\s*$/im.test(
      command,
    );
  if (touchesSecretFile) {
    deny("Editing environment or credential files is prohibited; change templates or named non-secret configuration instead.");
  }
  process.exit(0);
}

if (!/^(?:Bash|exec_command)$/i.test(toolName)) {
  process.exit(0);
}

if (
  /\b(?:cat|type|more|Get-Content)\b[^\r\n]*(?:^|[\\/])\.env(?:\.server)?\b/i.test(command) ||
  /\b(?:cat|type|more|Get-Content)\b[^\r\n]*(?:credentials?|secrets?)(?:\.[^\s]+)?\b/i.test(command)
) {
  deny("Reading secret-bearing environment or credential files is prohibited. Inspect names or selected non-secret values only.");
  process.exit(0);
}

if (
  /\bb2(?:\.exe)?\s+(?:delete-file-version|rm|delete-bucket|update-bucket)\b/i.test(command) ||
  /\baws\s+s3(?:api)?\s+(?:rm|delete-object|delete-objects|delete-bucket|put-bucket-lifecycle-configuration)\b/i.test(command) ||
  /\brclone\s+(?:delete|deletefile|purge|rmdirs)\b/i.test(command)
) {
  deny("B2/object-storage deletion, bucket management, lifecycle mutation and governance bypass are prohibited by the repository contract.");
  process.exit(0);
}

const mutatesProtectedCoTenant =
  /\bdocker(?:\s+compose)?\b[^\r\n]*\b(?:stop|restart|rm|kill|up|down|build|create)\b[^\r\n]*robinhoodscaner/i.test(
    command,
  ) ||
  /robinhoodscaner[^\r\n]*\bdocker(?:\s+compose)?\b[^\r\n]*\b(?:stop|restart|rm|kill|up|down|build|create)\b/i.test(
    command,
  );
if (mutatesProtectedCoTenant) {
  deny("Mutation of the protected Robinhoodscaner co-tenant is prohibited.");
  process.exit(0);
}

const warnings = [];
const riskyPatterns = [
  [/\bdocker\s+(?:system|builder|image|container|volume)\s+(?:prune|rm)\b/i, "global Docker prune/removal"],
  [/\bdocker(?:\s+compose|-compose)\b[^\r\n]*\bdown\b/i, "Compose down"],
  [/\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*f)\b/i, "destructive Git cleanup"],
  [/\brsync\b[^\r\n]*--delete\b/i, "rsync --delete"],
  [/\b(?:rm\s+-[^\s]*r|Remove-Item\b[^\r\n]*-Recurse)\b/i, "recursive filesystem deletion"],
  [/\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\b|VACUUM\s+FULL\b|DELETE\s+FROM\b)/i, "destructive database operation"],
  [/(?:^|[\\/])scripts[\\/]deploy\.sh\b/i, "legacy broad deployment script"],
];
for (const [pattern, label] of riskyPatterns) {
  if (pattern.test(command)) warnings.push(label);
}

if (warnings.length > 0) {
  warn(
    `${[...new Set(warnings)].join(", ")} detected. Require fresh explicit authority, exact resolved targets, backup/rollback evidence, headroom, and pre/post co-tenant verification before proceeding.`,
  );
}
