import path from "path";

const DEFAULT_TEMPERATURE = 0.15;
const HELPER_TIMEOUT_MS = 20000;
const OUTPUT_PREVIEW_LIMIT = 420;

const NAVIGATION_SCHEMA = [
  "{",
  '  "schema_version": "string // schema identifier (default navigation-plan@v1)",',
  '  "navigation_summary": "<=160 characters overview",',
  '  "recommended_paths": ["relative/path", "glob"],',
  '  "file_types": ["js", "md"],',
  '  "focus_commands": ["npm run lint"],',
  '  "actions": [',
  "    {",
    '      "command": "string // shell command to execute",',
    '      "reason": "string // why this command matters",',
    '      "danger": "low|mid|high // predicted risk",',
    '      "authorization_hint": "string|null // additional warning or requirement"',
  "    }",
  "  ],",
  '  "helper_script": {',
  '    "language": "node|python",',
  '    "name": "friendly title",',
  '    "description": "why the helper is needed",',
  '    "code": "fully executable source code"',
  "  },",
  '  "notes": "optional supporting context"',
  "}",
].join("\n");

const SYSTEM_PROMPT = [
  "You are the MiniPhi navigation advisor.",
  "Given workspace stats, file manifests, and existing tool inventories, explain how to traverse the repo.",
  "Return JSON that matches the provided schema exactly; omit prose outside the JSON response.",
  "When additional telemetry is required (e.g., enumerating files, parsing manifests), emit a minimal helper script.",
  "Helper scripts must be idempotent, safe, and runnable via Node.js or Python without extra dependencies.",
].join(" ");

function stripCodeFences(text = "") {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("```")) {
    const nextLine = trimmed.indexOf("\n");
    const fence = trimmed.slice(0, nextLine === -1 ? trimmed.length : nextLine);
    if (/```json/i.test(fence)) {
      return trimmed.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
    }
    return trimmed.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
  }
  return trimmed;
}

function clampText(text, limit = OUTPUT_PREVIEW_LIMIT) {
  if (!text) {
    return "";
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}…`;
}

export default class ApiNavigator {
  constructor(options = undefined) {
    this.restClient = options?.restClient ?? null;
    this.cli = options?.cliExecutor ?? null;
    this.memory = options?.memory ?? null;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.temperature = options?.invocationTemperature ?? DEFAULT_TEMPERATURE;
    this.helperTimeout = options?.helperTimeout ?? HELPER_TIMEOUT_MS;
    this.adapterRegistry = options?.adapterRegistry ?? null;
    this.disabled = false;
  }

  setMemory(memory) {
    this.memory = memory ?? null;
  }

  /**
   * Asks LM Studio for navigation guidance and optional helper scripts.
   * @param {{
   *   workspace: Record<string, any>,
   *   capabilities?: Record<string, any> | null,
   *   objective?: string | null,
   *   cwd?: string,
   *   executeHelper?: boolean
   * }} payload
   */
  async generateNavigationHints(payload = undefined) {
    if (this.disabled) {
      this._log("[ApiNavigator] Disabled after previous failures; skipping navigation hints.");
      return null;
    }
    if (!this.restClient || !payload?.workspace) {
      return null;
    }
    const plan = await this._requestPlan(payload);
    if (!plan) {
      return null;
    }
    const normalizedPlan = this._normalizePlan(plan);
    if (!normalizedPlan) {
      return null;
    }
    let helper = null;
    if (
      normalizedPlan.helper_script?.code &&
      this.memory &&
      this.cli &&
      payload.executeHelper !== false
    ) {
      helper = await this._materializeHelperScript(normalizedPlan.helper_script, payload).catch(
        (error) => {
          this._log(
            `[ApiNavigator] Helper script failed: ${error instanceof Error ? error.message : error}`,
          );
          return null;
        },
      );
    }
    const actions = this._normalizeActions(normalizedPlan.actions);
    return {
      summary: normalizedPlan.navigation_summary ?? null,
      recommendedPaths: Array.isArray(normalizedPlan.recommended_paths)
        ? normalizedPlan.recommended_paths
        : [],
      fileTypes: Array.isArray(normalizedPlan.file_types) ? normalizedPlan.file_types : [],
      focusCommands: Array.isArray(normalizedPlan.focus_commands)
        ? normalizedPlan.focus_commands
        : [],
      actions,
      helper,
      block: this._buildNavigationBlock(normalizedPlan, helper, actions),
      raw: normalizedPlan,
      schemaVersion: normalizedPlan.schema_version ?? null,
    };
  }

  _normalizePlan(plan) {
    if (!plan) {
      return null;
    }
    const schemaVersion = plan.schema_version ?? "navigation-plan@v1";
    if (!this.adapterRegistry) {
      return { ...plan, schema_version: schemaVersion };
    }
    return this.adapterRegistry.normalizeResponse("api-navigator", schemaVersion, plan);
  }

  _normalizeActions(rawActions) {
    if (!Array.isArray(rawActions)) {
      return [];
    }
    return rawActions
      .map((entry) => {
        if (!entry?.command) {
          return null;
        }
        return {
          command: entry.command,
          reason: entry.reason ?? null,
          danger: entry.danger ?? "mid",
          authorizationHint: entry.authorization_hint ?? entry.authorizationHint ?? null,
        };
      })
      .filter(Boolean);
  }
  async _requestPlan(payload) {
    const manifest = Array.isArray(payload.workspace?.manifestPreview)
      ? payload.workspace.manifestPreview.slice(0, 12)
      : [];
    const body = {
      objective: payload.objective ?? null,
      cwd: payload.cwd ?? process.cwd(),
      workspace: {
        classification: payload.workspace?.classification ?? null,
        summary: payload.workspace?.summary ?? null,
        stats: payload.workspace?.stats ?? null,
        highlights: payload.workspace?.highlights ?? null,
        hintBlock: payload.workspace?.hintBlock ?? null,
      },
      manifest,
      capabilitySummary: payload.capabilities?.summary ?? null,
      capabilities: payload.capabilities?.details ?? payload.capabilities ?? null,
    };
    const messages = [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\nJSON schema:\n\`\`\`json\n${NAVIGATION_SCHEMA}\n\`\`\``,
      },
      {
        role: "user",
        content: JSON.stringify(body, null, 2),
      },
    ];
    try {
      const completion = await this.restClient.createChatCompletion({
        messages,
        temperature: this.temperature,
        max_tokens: -1,
      });
      const raw = completion?.choices?.[0]?.message?.content ?? "";
      return this._parsePlan(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._log(`[ApiNavigator] Failed to request navigation hints: ${message}`);
      if (this._shouldDisable(message)) {
        this.disabled = true;
        this._log("[ApiNavigator] Disabling navigator for current session after repeated failures.");
      }
      return null;
    }
  }

  _shouldDisable(message) {
    if (!message) {
      return false;
    }
    return /timed out/i.test(message) || /ECONNREFUSED|ENOTFOUND/i.test(message);
  }

  _parsePlan(raw) {
    const extracted = stripCodeFences(raw);
    if (!extracted) {
      return null;
    }
    try {
      return JSON.parse(extracted);
    } catch (error) {
      this._log(
        `[ApiNavigator] Unable to parse navigation plan: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async _materializeHelperScript(definition, payload) {
    if (!definition?.code) {
      return null;
    }
    const record = await this.memory.recordHelperScript({
      name: definition.name ?? "api-navigator-helper",
      description: definition.description ?? null,
      language: definition.language ?? "node",
      code: definition.code,
      source: "api-navigator",
      objective: payload.objective ?? null,
      workspaceType: payload.workspace?.classification?.label ?? null,
      notes: definition.notes ?? null,
    });
    if (!record) {
      return null;
    }
    let runRecord = null;
    const execution = await this._executeHelper(record.path, definition.language, payload.cwd);
    if (execution) {
      const summary = this._summarizeHelperOutput(execution.stdout, execution.stderr);
      runRecord = await this.memory.recordHelperScriptRun({
        id: record.entry.id,
        command: execution.command,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        summary,
      });
    }
    return {
      id: record.entry.id,
      name: record.entry.name,
      language: record.entry.language,
      description: record.entry.description ?? null,
      path: record.entry.path,
      absolutePath: record.path,
      run: runRecord,
    };
  }

  async _executeHelper(scriptPath, language, cwd) {
    if (!this.cli) {
      return null;
    }
    const absolutePath = path.resolve(scriptPath);
    const normalizedLang = this._normalizeLanguage(language);
    const runner = normalizedLang === "python" ? "python" : "node";
    const command = `${runner} "${absolutePath}"`;
    try {
      const result = await this.cli.executeCommand(command, {
        cwd: cwd ?? path.dirname(absolutePath),
        timeout: this.helperTimeout,
        captureOutput: true,
      });
      return {
        command,
        exitCode: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    } catch (error) {
      return {
        command,
        exitCode: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  _summarizeHelperOutput(stdout, stderr) {
    const segments = [];
    if (stdout) {
      segments.push(`stdout ${clampText(stdout)}`);
    }
    if (stderr) {
      segments.push(`stderr ${clampText(stderr)}`);
    }
    return segments.join(" | ") || null;
  }

  _buildNavigationBlock(plan, helper, actions = undefined) {
    const lines = [];
    if (plan.navigation_summary) {
      lines.push(`Navigation summary: ${plan.navigation_summary}`);
    }
    if (Array.isArray(plan.recommended_paths) && plan.recommended_paths.length) {
      lines.push(`Paths to inspect: ${plan.recommended_paths.join(", ")}`);
    }
    if (Array.isArray(plan.file_types) && plan.file_types.length) {
      lines.push(`Key file types: ${plan.file_types.join(", ")}`);
    }
    if (Array.isArray(actions) && actions.length) {
      const formatted = actions
        .map((action) => {
          const segments = [`${action.command} (${action.danger ?? "mid"})`];
          if (action.reason) {
            segments.push(action.reason);
          }
          if (action.authorizationHint) {
            segments.push(action.authorizationHint);
          }
          return `- ${segments.join(" | ")}`;
        })
        .join("\n");
      lines.push(`Proposed actions:\n${formatted}`);
    }
    if (Array.isArray(plan.focus_commands) && plan.focus_commands.length) {
      lines.push(`Suggested commands: ${plan.focus_commands.join(", ")}`);
    }
    if (plan.notes) {
      lines.push(plan.notes);
    }
    if (helper) {
      const runSummary = helper.run?.summary ?? "pending execution";
      lines.push(
        `Helper script (${helper.language} @ ${helper.path}): ${helper.description ?? "workspace scan"} -> ${runSummary}`,
      );
    }
    return lines.join("\n") || null;
  }

  _normalizeLanguage(language) {
    const normalized = (language ?? "").toString().trim().toLowerCase();
    if (normalized.startsWith("py")) {
      return "python";
    }
    if (normalized.startsWith("node") || normalized === "js" || normalized === "javascript") {
      return "node";
    }
    return "node";
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }
}
