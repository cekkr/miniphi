import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_COMMANDS, buildAgentCommandsBlock } from "../src/libs/agent-commands.js";

test("buildAgentCommandsBlock renders compressed default commands", () => {
  const block = buildAgentCommandsBlock();
  assert.ok(block, "block should be non-null");
  const lines = block.split("\n");
  assert.ok(lines.length >= DEFAULT_AGENT_COMMANDS.length, "block should list commands");
  // Descriptions should stay short for prompt budget; enforce <= 80 chars per line.
  for (const line of lines.slice(1)) {
    assert.ok(line.length <= 80, `line too long: ${line.length}`);
    assert.match(line, /^- \w+:/, "each entry should be bullet with id prefix");
  }
});
