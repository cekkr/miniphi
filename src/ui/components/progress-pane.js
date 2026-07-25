import { html, Box, Text } from "../ink-elements.js";
import { spinnerFrame, statusStyle } from "../theme.js";

const MAX_LOG_ROWS = 16;

/**
 * Scrolling activity log for the running agent: status lines, read/search
 * actions, and applied/rejected edits. `log` is an array of
 * `{ kind, text, status }`; the tail is shown so recent activity stays visible.
 */
export default function ProgressPane({ task, log = [], running = false, tick = 0, summary = "" }) {
  const rows = log.slice(-MAX_LOG_ROWS);
  return html`
    <${Box} flexDirection="column">
      <${Box}>
        <${Text} color="magenta" bold>Task: </${Text}>
        <${Text}>${task}</${Text}>
      </${Box}>
      <${Box} flexDirection="column" marginTop=${1}>
        ${rows.map((entry, i) => {
          if (entry.kind === "status") {
            return html`<${Text} key=${i} color="blue">▸ ${entry.text}</${Text}>`;
          }
          const style = statusStyle(entry.status);
          return html`<${Text} key=${i} color=${style.color}>${style.glyph} ${entry.text}</${Text}>`;
        })}
        ${log.length === 0 ? html`<${Text} dimColor>starting…</${Text}>` : null}
      </${Box}>
      <${Box} marginTop=${1}>
        ${running
          ? html`<${Text} color="cyan">${spinnerFrame(tick)} thinking…</${Text}>`
          : html`<${Text} color="green">${summary ? `✔ ${summary}` : "done"}</${Text}>`}
      </${Box}>
    </${Box}>
  `;
}
