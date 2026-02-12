const DEFAULT_AGENT_COMMANDS = [
  { id: "workspace", description: "Summarize workspace shape; no edits." },
  { id: "list_dir", description: "List files/dirs (bounded depth, respects ignore)." },
  { id: "read_file", description: "Show file content for review (no edits)." },
  { id: "search_text", description: "Ripgrep text pattern across workspace." },
  { id: "edit_file", description: "Apply minimal patch/write to a file." },
  { id: "run_cmd", description: "Execute safe shell command with timeout." },
  { id: "analyze_file", description: "Summarize a file with schema-checked JSON." },
  { id: "web_research", description: "DuckDuckGo instant answers; cached locally." },
  { id: "web_browse", description: "Fetch page text/screenshot via headless browser." },
];

function buildAgentCommandsBlock(commands = DEFAULT_AGENT_COMMANDS) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return null;
  }
  const lines = ["Agent commands (defaults):"];
  for (const cmd of commands) {
    if (!cmd || !cmd.id || !cmd.description) continue;
    lines.push(`- ${cmd.id}: ${cmd.description}`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

export { DEFAULT_AGENT_COMMANDS, buildAgentCommandsBlock };
