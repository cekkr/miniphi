import { useInput } from "ink";
import { html, Box, Text, useState } from "../ink-elements.js";
import {
  REASONING_PROFILE_NAMES,
  resolveReasoningProfile,
} from "../../libs/reasoning-profile.js";

const LABELS = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

function formatTime(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "none";
  return `${Math.round(milliseconds / 1000)}s`;
}

export default function ReasoningPicker({
  selectedValue = "high",
  model = null,
  onSubmit,
}) {
  const initialIndex = Math.max(0, REASONING_PROFILE_NAMES.indexOf(selectedValue));
  const [cursor, setCursor] = useState(initialIndex);
  const profile = REASONING_PROFILE_NAMES[cursor] ?? "high";
  const resolution = resolveReasoningProfile({ profile, model, source: "ui" });

  useInput((input, key) => {
    if (key.return) {
      onSubmit?.(resolution);
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor((value) =>
        Math.min(value + 1, REASONING_PROFILE_NAMES.length - 1),
      );
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor((value) => Math.max(value - 1, 0));
    }
  });

  return html`
    <${Box} flexDirection="column">
      <${Text} color="magenta" bold>Choose reasoning effort</${Text}>
      <${Text} dimColor>
        Controls both model effort (when supported) and MiniPhi subprompts.
      </${Text}>
      <${Box} flexDirection="column" marginTop=${1}>
        ${REASONING_PROFILE_NAMES.map((name, index) => {
          const limits = resolveReasoningProfile({ profile: name, model }).agent;
          const active = index === cursor;
          return html`<${Text}
            key=${name}
            color=${active ? "cyan" : undefined}
            inverse=${active}
          >${active ? "❯" : " "} ${LABELS[name]} · ${limits.maxExpansions} subprompt(s) · depth ${limits.maxDepth}</${Text}>`;
        })}
      </${Box}>
      <${Box} flexDirection="column" marginTop=${1}>
        <${Text} dimColor>
          Branch budget: ${formatTime(resolution.agent.expansionTimeBudgetMs)}
          ${resolution.agent.expansionMaxTokens > 0
            ? ` · up to ${resolution.agent.expansionMaxTokens} tokens/subprompt`
            : resolution.agent.expansionMaxTokens === -1
              ? " · model token limit"
              : ""}
        </${Text}>
        <${Text} color=${resolution.model.supported ? "green" : "yellow"}>
          ${resolution.model.supported
            ? `Model effort: ${resolution.model.resolved}${resolution.model.exact ? "" : " (closest supported)"}`
            : "Model effort unsupported; MiniPhi decomposition still changes"}
        </${Text}>
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>↑/↓ move · Enter select</${Text}>
      </${Box}>
    </${Box}>
  `;
}
