export function checkGraphDeadline(deadline) {
  if (Date.now() >= deadline) throw new Error("session-timeout");
}

export async function executeGraphCommands(client, commands, trace, deadline) {
  checkGraphDeadline(deadline);
  const responses = await client.execute(commands);
  for (let i = 0; i < commands.length; i += 1) {
    const response = responses[i];
    trace.push({ command: commands[i], response: response ?? null });
    if (!response?.ok && !/\b(?:node|edge)_not_found\b/.test(response?.raw ?? "")) throw new Error(`Cheetah command failed: ${response?.raw ?? "missing response"}`);
  }
  checkGraphDeadline(deadline);
  return responses;
}
