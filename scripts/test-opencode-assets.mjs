import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.match(pkg.dependencies["@opencode/cli"] ?? "", /^\d+\.\d+\.\d+$/);
assert.ok(pkg.files.includes("opencode-assets"));

const frontmatter = (path) => {
  const m = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, `${path} has frontmatter`);
  return m[1];
};

const agent = frontmatter("opencode-assets/agents/scotty.md");
assert.match(agent, /^mode: primary$/m);
assert.match(
  agent,
  /action: shell\n\s+resource: "bd \*"\n\s+effect: allow/,
);
assert.match(
  agent,
  /action: shell\n\s+resource: "\*"\n\s+effect: ask/,
);

const skill = frontmatter("opencode-assets/skills/scotty-ui/SKILL.md");
assert.match(skill, /^description: \S.*$/m);

console.log("opencode assets ok");
