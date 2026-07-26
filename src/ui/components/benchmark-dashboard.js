import { useInput } from "ink";
import { html, Box, Text } from "../ink-elements.js";
import { modelBenchmarkTableRows } from "../../libs/model-benchmarks.js";

const MAX_ROWS = 8;

function cell(value) {
  return Number.isFinite(value) ? String(Math.round(value)).padStart(3) : "  –";
}
function modelLabel(value) {
  const text = String(value ?? "");
  return text.length > 28 ? `${text.slice(0, 25)}…` : text;
}

/**
 * Home screen and cached model-score table. `b` is the terminal equivalent of
 * the Easy benchmark button; it runs the same cache-aware service as
 * `benchmark models --easy`.
 */
export default function BenchmarkDashboard({
  benchmarkIndex = null,
  running = false,
  status = "",
  onStart,
  onRunEasy,
  onQuit,
}) {
  useInput((input, key) => {
    const normalized = String(input ?? "").toLowerCase();
    if (normalized === "q" || (key.ctrl && normalized === "c")) {
      onQuit?.();
      return;
    }
    if (running) {
      return;
    }
    if (key.return || normalized === "s") {
      onStart?.();
      return;
    }
    if (normalized === "b" || normalized === "e") {
      onRunEasy?.();
    }
  });

  const rows = modelBenchmarkTableRows(benchmarkIndex).slice(0, MAX_ROWS);
  return html`
    <${Box} flexDirection="column">
      <${Text} color="magenta" bold>What would you like to do?</${Text}>
      <${Box} marginTop=${1}>
        <${Text} color="cyan" inverse=${!running}> Enter  Start task </${Text}>
        <${Text}>  </${Text}>
        <${Text} color="green" inverse=${!running}> B  Easy benchmark </${Text}>
      </${Box}>
      <${Box} flexDirection="column" marginTop=${1}>
        <${Text} bold>Model benchmarks</${Text}>
        ${rows.length
          ? html`<${Text} dimColor>Model                         All Cod Rea Ctx Spd</${Text}>`
          : html`<${Text} dimColor>No fresh scores. Press B to benchmark installed chat models.</${Text}>`}
        ${rows.map(
          (row) => html`<${Text} key=${row.modelId}>
            ${modelLabel(row.modelId).padEnd(29)} ${cell(row.overall)} ${cell(row.coding)} ${cell(row.reasoning)} ${cell(row.context)} ${cell(row.speed)}
          </${Text}>`,
        )}
        ${Object.keys(benchmarkIndex?.results ?? {}).length > MAX_ROWS
          ? html`<${Text} dimColor>…and ${Object.keys(benchmarkIndex.results).length - MAX_ROWS} more</${Text}>`
          : null}
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} color=${running ? "yellow" : status.startsWith("Failed") ? "red" : "green"}>
          ${running ? `◌ ${status || "Preparing model benchmark…"}` : status}
        </${Text}>
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>Enter/S start task · B/E Easy benchmark · Q quit</${Text}>
      </${Box}>
    </${Box}>
  `;
}
