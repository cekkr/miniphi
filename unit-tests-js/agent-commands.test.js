import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_COMMANDS, buildAgentCommandsBlock } from "../src/libs/agent-commands.js";

test("buildAgentCommandsBlock renders compressed default commands", () => {
  const block = buildAgentCommandsBlock();
  assert.ok(block, "block should be non-null");
  const lines = block.split("\n");
  assert.equal(lines[0], "Agent commands (defaults):");
  assert.equal(lines.length, DEFAULT_AGENT_COMMANDS.length + 1, "one line per command plus header");
  // Every default command id must be listed exactly once, in order.
  DEFAULT_AGENT_COMMANDS.forEach((cmd, index) => {
    assert.match(lines[index + 1], new RegExp(`^- ${cmd.id}: `), `line for ${cmd.id}`);
  });
  // Descriptions should stay short for prompt budget; enforce <= 80 chars per line.
  for (const line of lines.slice(1)) {
    assert.ok(line.length <= 80, `line too long: ${line.length}`);
    assert.match(line, /^- \w+:/, "each entry should be bullet with id prefix");
  }
});

test("buildAgentCommandsBlock skips malformed entries and empty input", () => {
  assert.equal(buildAgentCommandsBlock([]), null);
  assert.equal(buildAgentCommandsBlock(null), null);
  assert.equal(buildAgentCommandsBlock([{ id: "", description: "x" }]), null);
  const block = buildAgentCommandsBlock([
    { id: "good", description: "keeps valid entries" },
    { id: "broken" },
    null,
  ]);
  assert.equal(block, "Agent commands (defaults):\n- good: keeps valid entries");
});

test("core local-file actions stay present in the defaults", () => {
  const ids = DEFAULT_AGENT_COMMANDS.map((cmd) => cmd.id);
  assert.equal(new Set(ids).size, ids.length, "command ids must be unique");
  for (const required of ["workspace", "read_file", "edit_file", "run_cmd", "analyze_file"]) {
    assert.ok(ids.includes(required), `missing core command ${required}`);
  }
});
