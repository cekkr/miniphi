import { useInput } from "ink";
import { html, Box, Text, useState } from "../ink-elements.js";

const VISIBLE_ROWS = 10;

function formatContext(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "?";
  }
  if (value >= 1024) {
    return `${Math.round(value / 1024)}k`;
  }
  return String(value);
}

function describeCapabilities(model) {
  const capabilities = Array.isArray(model?.capabilities)
    ? model.capabilities
    : [];
  return capabilities.length ? capabilities.join(",") : "text";
}

/**
 * Selects Auto or one exact normalized LM Studio model. Auto is resolved
 * before this component renders, so confirming it produces a concrete model
 * id and auditable selection reason.
 */
export default function ModelPicker({
  choices = [],
  selectedValue = "auto",
  intent = "general",
  onSubmit,
  onSkip,
}) {
  const initialIndex = Math.max(
    0,
    choices.findIndex((choice) => choice.value === selectedValue),
  );
  const [cursor, setCursor] = useState(initialIndex);
  const safeCursor = Math.min(cursor, Math.max(choices.length - 1, 0));

  useInput((input, key) => {
    if (key.escape) {
      if (onSkip) onSkip();
      return;
    }
    if (key.return) {
      const choice = choices[safeCursor];
      if (choice && onSubmit) {
        onSubmit(choice);
      }
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((value) => Math.min(value + 1, Math.max(choices.length - 1, 0)));
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((value) => Math.max(value - 1, 0));
    }
  });

  const start = Math.max(
    0,
    Math.min(
      safeCursor - Math.floor(VISIBLE_ROWS / 2),
      Math.max(choices.length - VISIBLE_ROWS, 0),
    ),
  );
  const rows = choices.slice(start, start + VISIBLE_ROWS);
  const focused = choices[safeCursor] ?? null;

  return html`
    <${Box} flexDirection="column">
      <${Text} color="magenta" bold>Choose an LM Studio model</${Text}>
      <${Text} dimColor>Task intent: ${intent}</${Text}>
      <${Box} flexDirection="column" marginTop=${1}>
        ${rows.map((choice, index) => {
          const rowIndex = start + index;
          const active = rowIndex === safeCursor;
          const model = choice.model ?? {};
          const label = choice.auto
            ? `Auto → ${choice.resolvedModel}`
            : choice.resolvedModel;
          const details = [
            model.state ?? "unknown",
            `ctx=${formatContext(model.loadedContextLength ?? model.maxContextLength)}`,
            describeCapabilities(model),
          ].join(" · ");
          return html`<${Text}
            key=${choice.value}
            color=${active ? "cyan" : choice.unavailable ? "yellow" : undefined}
            inverse=${active}
          >${active ? "❯" : " "} ${label} (${details})</${Text}>`;
        })}
        ${choices.length === 0
          ? html`<${Text} color="yellow">No chat-capable models discovered.</${Text}>`
          : null}
      </${Box}>
      ${focused?.reasons?.length
        ? html`<${Box} marginTop=${1}>
            <${Text} dimColor>${focused.reasons.join("; ")}</${Text}>
          </${Box}>`
        : null}
      <${Box} marginTop=${1}>
        <${Text} dimColor>↑/↓ move · Enter select · Esc keep current model</${Text}>
      </${Box}>
    </${Box}>
  `;
}
