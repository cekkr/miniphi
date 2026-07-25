import { useInput } from "ink";
import { html, Box, Text } from "../ink-elements.js";
import { dangerColor, diffRows } from "../theme.js";

const MAX_DIFF_ROWS = 16;

/**
 * Blocking approval prompt for a mutating action. Renders the edit diff (or the
 * command) and waits for y (approve once) / a (approve for session) / n (reject).
 * Calls `onDecision({ approved, scope })`.
 */
export default function PermissionModal({ request, onDecision }) {
  useInput((input) => {
    const key = (input || "").toLowerCase();
    if (key === "y") {
      onDecision({ approved: true, scope: "once" });
    } else if (key === "a") {
      onDecision({ approved: true, scope: "session" });
    } else if (key === "n") {
      onDecision({ approved: false, reason: "rejected by operator" });
    }
  });

  const isCommand = request?.kind === "command";
  const title = isCommand ? "Run command" : `${request?.type ?? "edit"} ${request?.path ?? ""}`.trim();
  const rows = diffRows(request?.diff).slice(0, MAX_DIFF_ROWS);
  const truncated = diffRows(request?.diff).length > MAX_DIFF_ROWS;

  return html`
    <${Box} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX=${1}>
      <${Box}>
        <${Text} color="yellow" bold>⚠ Permission required · </${Text}>
        <${Text} bold>${title}</${Text}>
        ${request?.danger
          ? html`<${Text} color=${dangerColor(request.danger)}> [danger=${request.danger}]</${Text}>`
          : null}
      </${Box}>
      ${request?.reason ? html`<${Text} dimColor>${request.reason}</${Text}>` : null}
      ${isCommand
        ? html`<${Box} marginTop=${1}><${Text} color="cyan">$ ${request.command}</${Text}></${Box}>`
        : html`
            <${Box} flexDirection="column" marginTop=${1}>
              ${request?.isNewFile ? html`<${Text} color="green">(new file)</${Text}>` : null}
              ${rows.length === 0
                ? html`<${Text} dimColor>(no line-level changes)</${Text}>`
                : rows.map((row, i) => html`<${Text} key=${i} color=${row.color}>${row.line}</${Text}>`)}
              ${truncated ? html`<${Text} dimColor>… diff truncated</${Text}>` : null}
            </${Box}>
          `}
      <${Box} marginTop=${1}>
        <${Text} color="green">y</${Text}><${Text}> approve · </${Text}>
        <${Text} color="cyan">a</${Text}><${Text}> approve for session · </${Text}>
        <${Text} color="red">n</${Text}><${Text}> reject</${Text}>
      </${Box}>
    </${Box}>
  `;
}
