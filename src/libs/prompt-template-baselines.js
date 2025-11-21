import { LOG_ANALYSIS_FALLBACK_SCHEMA } from "./efficient-log-analyzer.js";

const DEFAULT_TRUNCATION_TASK =
  "Teach the operator how to split an oversized log or output dataset so Phi-4 can analyze it across multiple prompts without losing context.";
const DEFAULT_ANALYSIS_TASK =
  "Review the captured logs/command output and explain the failures with concrete evidence, recommended fixes, and next steps.";
const DEFAULT_HISTORY_KEYS = ["chunk_label", "line_window", "symptom", "helper_commands"];

function formatSchemaBlock(text) {
  if (!text) {
    return ["```json", LOG_ANALYSIS_FALLBACK_SCHEMA, "```"].join("\n");
  }
  return text;
}

export default class PromptTemplateBaselineBuilder {
  constructor(options = undefined) {
    this.schemaRegistry = options?.schemaRegistry ?? null;
  }

  build(payload) {
    const target = (payload?.baseline ?? "truncation").toString().trim().toLowerCase();
    switch (target) {
      case "truncation":
      case "truncate":
      case "chunking":
        return this._buildTruncationTemplate(payload ?? {});
      case "analysis":
      case "log-analysis":
      case "loganalysis":
      case "base":
      case "log":
        return this._buildLogAnalysisTemplate(payload ?? {});
      default:
        throw new Error(`Unsupported prompt template baseline: ${target}`);
    }
  }

  _buildTruncationTemplate(payload) {
    const schemaId = "log-analysis";
    const schemaBlock = formatSchemaBlock(
      this.schemaRegistry?.buildInstructionBlock?.(schemaId) ?? null,
    );
    const task = (payload.task ?? DEFAULT_TRUNCATION_TASK).trim();
    const datasetSummary = (payload.datasetSummary ?? "Oversized output captured from the current workspace.").trim();
    const datasetStats = {
      totalLines: coerceNumber(payload.datasetStats?.totalLines),
      chunkTarget: coerceNumber(payload.datasetStats?.chunkTarget),
    };
    const helperFocus = normalizeList(payload.helperFocus);
    const requestedHistoryKeys = normalizeList(payload.historyKeys);
    const historyKeys = requestedHistoryKeys.length ? requestedHistoryKeys : DEFAULT_HISTORY_KEYS;
    const notes = payload.notes?.trim() || null;
    const workspaceBlock = this._formatWorkspaceSection(payload.workspaceContext);
    const datasetBlock = this._formatDatasetSection(datasetSummary, datasetStats, helperFocus);
    const focusBlock = this._formatTruncationFocusBlock(historyKeys, helperFocus, datasetStats);

    const sections = [
      "# Baseline Prompt — Teach Me To Truncate Inputs",
      "You are MiniPhi's truncation strategist. The operator captured a dataset that exceeds the prompt window and needs deterministic guidance on how to split it while preserving history between prompts. Respond with JSON **only**.",
      `Schema requirements:\n${schemaBlock}`,
      `## Task\n${task}`,
      datasetBlock,
      workspaceBlock,
      focusBlock,
      notes ? `## Extra Notes\n${notes}` : null,
      "Always populate `truncation_strategy` with concrete chunk goals, helper commands/scripts, carryover fields, and a history schema that can be replayed in later prompts.",
    ].filter(Boolean);

    const prompt = sections.join("\n\n").trim();
    const metadata = {
      baseline: "truncation",
      datasetSummary,
      datasetStats,
      helperFocus,
      historyKeys,
      workspace: this._sanitizeWorkspaceMetadata(payload.workspaceContext),
      notes,
    };

    return { prompt, schemaId, task, metadata };
  }

  _buildLogAnalysisTemplate(payload) {
    const schemaId = (payload.schemaId ?? "log-analysis").toString().trim() || "log-analysis";
    const schemaBlock = formatSchemaBlock(
      this.schemaRegistry?.buildInstructionBlock?.(schemaId) ?? null,
    );
    const task = (payload.task ?? DEFAULT_ANALYSIS_TASK).trim();
    const datasetSummary = (
      payload.datasetSummary ?? "Recent command output / logs captured from the workspace."
    ).trim();
    const datasetStats = {
      totalLines: coerceNumber(payload.datasetStats?.totalLines),
      chunkTarget: coerceNumber(payload.datasetStats?.chunkTarget),
    };
    const helperFocus = normalizeList(payload.helperFocus);
    const notes = payload.notes?.trim() || null;
    const workspaceBlock = this._formatWorkspaceSection(payload.workspaceContext);
    const datasetBlock = this._formatDatasetSection(datasetSummary, datasetStats, helperFocus);
    const reportingRules = this._formatReportingRules([
      "Keep `evidence` tightly scoped to observed lines, pointing to the chunk label and an approximate line number.",
      "Use `recommended_fixes[].commands` to capture concrete remediation commands/scripts. Leave the array empty when nothing applies instead of omitting the field.",
      "Populate `truncation_strategy` whenever the dataset feels incomplete or needs chunking guidance so operators can resume deterministically.",
    ]);
    const contextExtras = helperFocus.length
      ? `\n- Tools/helpers already available: ${helperFocus.join(", ")}`
      : "";
    const dataOverview = ["## Data Context", `- Summary: ${datasetSummary}`];
    if (datasetStats.totalLines) {
      dataOverview.push(`- Captured lines: ~${datasetStats.totalLines}`);
    }
    if (datasetStats.chunkTarget) {
      dataOverview.push(`- Target lines per chunk: ${datasetStats.chunkTarget}`);
    }
    if (contextExtras) {
      dataOverview.push(contextExtras.trim());
    }

    const sections = [
      "# Baseline Prompt — Log/Command Analysis",
      "You are MiniPhi's log analyst. Review the captured logs/output, explain root causes, cite evidence, recommend concrete fixes, and list next steps. Respond with JSON **only**.",
      `Schema requirements:\n${schemaBlock}`,
      `## Task\n${task}`,
      dataOverview.filter(Boolean).join("\n"),
      datasetBlock,
      workspaceBlock,
      reportingRules,
      notes ? `## Extra Notes\n${notes}` : null,
    ].filter(Boolean);

    const prompt = sections.join("\n\n").trim();
    const metadata = {
      baseline: "log-analysis",
      datasetSummary,
      datasetStats,
      helperFocus,
      workspace: this._sanitizeWorkspaceMetadata(payload.workspaceContext),
      notes,
      schemaId,
    };
    return { prompt, schemaId, task, metadata };
  }

  _formatDatasetSection(summary, stats, helperFocus) {
    const lines = ["## Dataset Snapshot", `- Overview: ${summary}`];
    if (stats.totalLines) {
      lines.push(`- Approximate lines captured: ${stats.totalLines}`);
    }
    if (stats.chunkTarget) {
      lines.push(`- Desired per-chunk line budget: ${stats.chunkTarget}`);
    }
    if (helperFocus.length) {
      lines.push(`- Prep utilities to factor in: ${helperFocus.join(", ")}`);
    }
    return lines.join("\n");
  }

  _formatWorkspaceSection(context) {
    if (!context) {
      return null;
    }
    const lines = ["## Workspace Insight"];
    if (context.summary) {
      lines.push(`- Summary: ${context.summary}`);
    }
    const label = context.classification?.label ?? context.classification?.domain ?? null;
    if (label) {
      lines.push(`- Classification: ${label}`);
    }
    if (context.connectionSummary) {
      lines.push(`- Connections: ${context.connectionSummary}`);
    }
    if (context.capabilitySummary) {
      lines.push(`- Capabilities: ${context.capabilitySummary}`);
    }
    if (context.hintBlock) {
      lines.push(["```", context.hintBlock.trim(), "```"].join("\n"));
    }
    return lines.join("\n");
  }

  _formatTruncationFocusBlock(historyKeys, helperFocus, stats) {
    const lines = [
      "## Deliverable Expectations",
      "1. Use `truncation_strategy.chunking_plan` to name the upcoming chunks, include priorities, and describe the focus of each slice.",
      "2. Recommend helper commands/scripts inside `recommended_fixes[].commands` so the operator can pre-split logs before rerunning MiniPhi.",
      `3. Populate \`truncation_strategy.carryover_fields\` with the history keys to persist between prompts (e.g., ${historyKeys.join(", ")}).`,
      "4. Describe how to record summaries outside the current chunk via `truncation_strategy.history_schema`.",
      "5. Call out blockers or validation steps under `next_steps` so the operator knows when to retry the analyzer.",
    ];
    if (stats?.chunkTarget) {
      lines.push(`- Stay within roughly ${stats.chunkTarget} lines per chunk to honor the operator's budget.`);
    }
    if (helperFocus.length) {
      lines.push(`- Emphasize how to leverage: ${helperFocus.join(", ")}.`);
    }
    return lines.join("\n");
  }

  _formatReportingRules(extra = []) {
    const rules = [
      "Return valid JSON that matches the schema; never emit markdown or natural-language paragraphs outside the JSON.",
      "Stay grounded in the provided data—do not hallucinate files, commands, or outcomes that were not observed.",
      "Keep summaries concise (<= 2 sentences) and prefer bullet-proof evidence over speculation.",
      ...extra,
    ].filter(Boolean);
    const lines = ["## Reporting Rules", ...rules.map((rule) => `- ${rule}`)];
    return lines.join("\n");
  }

  _sanitizeWorkspaceMetadata(context) {
    if (!context) {
      return null;
    }
    return {
      summary: context.summary ?? null,
      classification: context.classification ?? null,
      capabilitySummary: context.capabilitySummary ?? null,
      connectionSummary: context.connectionSummary ?? null,
      hintBlock: context.hintBlock ?? null,
      manifestPreview: Array.isArray(context.manifestPreview)
        ? context.manifestPreview.slice(0, 10)
        : null,
    };
  }

}

function normalizeList(value) {
  if (!value && value !== 0) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeList(entry)).filter(Boolean);
  }
  const text = value.toString().trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function coerceNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}
