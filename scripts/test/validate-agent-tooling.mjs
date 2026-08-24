import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

const agentsPath = join(root, "AGENTS.md");
const agents = read("AGENTS.md");
assert.ok(statSync(agentsPath).size <= 32_768, "AGENTS.md exceeds the configured 32 KiB budget");

const config = read(".codex/config.toml");
assert.match(config, /^project_doc_max_bytes\s*=\s*32768\s*$/m);

const gitignore = read(".gitignore");
for (const trackedCodexPath of ["!.codex/config.toml", "!.codex/hooks.json", "!.codex/hooks/"]) {
  assert.ok(gitignore.includes(trackedCodexPath), `${trackedCodexPath} must remain trackable`);
}

const hooks = JSON.parse(read(".codex/hooks.json"));
assert.ok(Array.isArray(hooks?.hooks?.PreToolUse), "PreToolUse hook is missing");
assert.ok(existsSync(join(root, ".codex/hooks/pre-tool-use-guard.mjs")));

const skillsRoot = join(root, ".agents/skills");
const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(skillNames, [
  "walletscaner-alpha-research",
  "walletscaner-audit",
  "walletscaner-data-pipeline",
  "walletscaner-production-ops"
]);

for (const skillName of skillNames) {
  const skill = read(`.agents/skills/${skillName}/SKILL.md`);
  const metadata = skill.match(/^---\s*\nname:\s*([^\n]+)\ndescription:\s*"([^"]+)"\s*\n---/);
  assert.ok(metadata, `${skillName} has invalid frontmatter`);
  assert.equal(metadata[1].trim(), skillName);
  assert.ok(metadata[2].length >= 40, `${skillName} description is not discriminating`);
  assert.doesNotMatch(skill, /\bTODO\b/);

  const ui = read(`.agents/skills/${skillName}/agents/openai.yaml`);
  assert.match(ui, /^\s*display_name:\s*"[^"]+"\s*$/m);
  assert.match(ui, /^\s*short_description:\s*"[^"]{25,64}"\s*$/m);
  assert.ok(ui.includes(`$${skillName}`), `${skillName} default prompt must name the skill`);
  assert.ok(agents.includes(`$${skillName}`), `AGENTS.md must route ${skillName}`);
}

for (const path of [
  "docs/agent/current-state.md",
  "docs/agent/codex-tooling.md",
  "docs/agent/operating-contract-history-20260823.md"
]) {
  assert.ok(existsSync(join(root, path)), `${path} is missing`);
}

console.log(
  `agent-tooling-ok skills=${skillNames.length} agents_bytes=${statSync(agentsPath).size}`
);
