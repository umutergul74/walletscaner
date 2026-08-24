import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./pre-tool-use-guard.mjs", import.meta.url));

function invoke(toolName, toolInput) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test("allows bounded read-only commands", () => {
  assert.equal(invoke("Bash", { command: "docker ps --filter label=com.docker.compose.project=walletscaner" }), null);
});

test("denies secret reads", () => {
  const output = invoke("Bash", { command: "Get-Content C:\\repo\\.env.server" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("allows environment templates but denies environment edits", () => {
  assert.equal(
    invoke("apply_patch", { command: "*** Update File: C:\\repo\\.env.example\n" }),
    null,
  );
  const output = invoke("apply_patch", { command: "*** Update File: C:\\repo\\.env.server\n" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("denies object-storage deletion", () => {
  const output = invoke("Bash", { command: "b2 delete-file-version object id" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("allows co-tenant inventory but denies co-tenant mutation", () => {
  assert.equal(invoke("Bash", { command: "docker ps | Select-String robinhoodscaner" }), null);
  const output = invoke("Bash", { command: "docker restart robinhoodscaner-intel-api" });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
});

test("warns without denying operations that require fresh authority", () => {
  const output = invoke("Bash", { command: "docker system prune" });
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.match(output.hookSpecificOutput.additionalContext, /fresh explicit authority/i);
});
