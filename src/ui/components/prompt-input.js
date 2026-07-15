import { html, Box, Text } from "../ink-elements.js";
import TextInput from "./text-input.js";

/**
 * Task entry box. Enter submits. Shows how many files are pinned so the operator
 * knows what context the agent will start with.
 */
export default function PromptInput({ value, onChange, onSubmit, pinnedCount = 0 }) {
  return html`
    <${Box} flexDirection="column">
      <${Box}>
        <${Text} color="magenta" bold>What should miniPhi do? </${Text}>
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} color="cyan">❯ </${Text}>
        <${TextInput} value=${value} onChange=${onChange} onSubmit=${onSubmit} placeholder="describe the task…" focus=${true} />
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>
          ${pinnedCount > 0 ? `${pinnedCount} file(s) pinned · ` : ""}Enter to run
        </${Text}>
      </${Box}>
    </${Box}>
  `;
}
