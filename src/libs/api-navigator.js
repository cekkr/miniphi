import { spawn } from "child_process";
import path from "path";
import { extractJsonBlock } from "./core-utils.js";

const DEFAULT_TEMPERATURE = 0.15;
const HELPER_TIMEOUT_MS = 20000;
const HELPER_SILENCE_TIMEOUT_MS = 12000;
const OUTPUT_PREVIEW_LIMIT = 420;
const PYTHON_RUNNER_CACHE_TTL_MS = 5 * 60 * 1000;
const PYTHON_RUNNER_CHECK_TIMEOUT_MS = 2500;

const NAVIGATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema_version: { type: "string" },
    navigation_summary: { type: "string" },
    recommended_paths: { type: "array", items: { type: "string" }, default: [] },
    file_types: { type: "array", items: { type: "string" }, default: [] },
    focus_commands: { type: "array", items: { type: "string" }, default: [] },
    actions: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "reason", "danger"],
        properties: {
          command: { type: "string" },
          reason: { type: "string" },
          danger: { type: "string", enum: ["low", "mid", "high"] },
          authorization_hint: { type: ["string", "null"] },
        },
      },
    },
    helper_script: {
      type: "object",
      additionalProperties: false,
      required: ["language", "code"],
      properties: {
        language: { type: "string", enum: ["node", "python"] },
        name: { type: "string" },
        description: { type: "string" },
        code: { type: "string" },
        stdin: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
    },
    notes: { type: ["string", "null"] },
  },
  required: ["actions"],
};

const JSON_ONLY_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "navigation-plan",
    schema: NAVIGATION_JSON_SCHEMA,
  },
};

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
  '    "code": "fully executable source code",',
  '    "stdin": "optional input to send via stdin"',
  "  },",
  '  "notes": "optional supporting context"',
  "}",
].join("\n");

const SYSTEM_PROMPT = [
  "You are the MiniPhi navigation advisor.",
  "Given workspace stats, file manifests, and existing tool inventories, explain how to traverse the repo.",
  "Return JSON that matches the provided schema exactly; omit prose outside the JSON response.",
  "When additional telemetry is required (e.g., enumerating files, parsing manifests), emit a minimal helper script.",
  "Helper scripts must be idempotent, safe, and runnable via Node.js or Python without extra dependencies. If stdin is required, include a compact sample payload under helper_script.stdin.",
].join(" ");

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
    this.globalMemory = options?.globalMemory ?? null;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
    this.temperature = options?.invocationTemperature ?? DEFAULT_TEMPERATURE;
    this.helperTimeout = options?.helperTimeout ?? HELPER_TIMEOUT_MS;
    this.helperSilenceTimeout =
      options?.helperSilenceTimeout ?? options?.helperSilenceTimeoutMs ?? HELPER_SILENCE_TIMEOUT_MS;
    this.adapterRegistry = options?.adapterRegistry ?? null;
    this.disabled = false;
    this.disableNotice = null;
    this.pythonRunnerCache = null;
    const navigationTimeoutMs =
      typeof options?.navigationRequestTimeoutMs === "number"
        ? options.navigationRequestTimeoutMs
        : null;
    this.navigationRequestTimeoutMs =
      navigationTimeoutMs && navigationTimeoutMs > 0 ? navigationTimeoutMs : 60000;
    this.lastStopReason = null;
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
    const base = { ...plan, schema_version: schemaVersion };
    const normalizedPlan = this.adapterRegistry
      ? this.adapterRegistry.normalizeResponse("api-navigator", schemaVersion, base)
      : base;
    if (this.lastStopReason && !normalizedPlan.stop_reason) {
      normalizedPlan.stop_reason = this.lastStopReason;
    }
    return normalizedPlan;
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
    const buildBody = (compact = false) => {
      const manifest = Array.isArray(payload.workspace?.manifestPreview)
        ? payload.workspace.manifestPreview.slice(0, compact ? 2 : 12)
        : [];
      return {
        objective: payload.objective ?? null,
        cwd: payload.cwd ?? process.cwd(),
        workspace: {
          classification: payload.workspace?.classification ?? null,
          summary: compact
            ? this._compactText(payload.workspace?.summary, 320)
            : payload.workspace?.summary ?? null,
          stats: compact ? null : payload.workspace?.stats ?? null,
          highlights: compact ? null : payload.workspace?.highlights ?? null,
          hintBlock: compact
            ? this._compactText(payload.workspace?.hintBlock, 280)
            : payload.workspace?.hintBlock ?? null,
        },
        manifest: compact ? [] : manifest,
        capabilitySummary: compact
          ? this._compactText(payload.capabilities?.summary, 240)
          : payload.capabilities?.summary ?? null,
        capabilities: compact ? null : payload.capabilities?.details ?? payload.capabilities ?? null,
      };
    };
    const buildMessages = (body) => [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}\nJSON schema:\n\`\`\`json\n${NAVIGATION_SCHEMA}\n\`\`\``,
      },
      {
        role: "user",
        content: JSON.stringify(body, null, 2),
      },
    ];
    let body = buildBody(false);
    let compactTried = false;
    try {
      const completion = await this.restClient.createChatCompletion({
        messages: buildMessages(body),
        temperature: this.temperature,
        max_tokens: -1,
        response_format: JSON_ONLY_RESPONSE_FORMAT,
        timeoutMs: this.navigationRequestTimeoutMs,
      });
      const raw = completion?.choices?.[0]?.message?.content ?? "";
      return this._parsePlan(raw);
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      if (this._isContextOverflowError(message) && !compactTried) {
        compactTried = true;
        body = buildBody(true);
        try {
          const completion = await this.restClient.createChatCompletion({
            messages: buildMessages(body),
            temperature: this.temperature,
            max_tokens: -1,
            response_format: JSON_ONLY_RESPONSE_FORMAT,
            timeoutMs: this.navigationRequestTimeoutMs,
          });
          const raw = completion?.choices?.[0]?.message?.content ?? "";
          return this._parsePlan(raw);
        } catch (compactError) {
          message = compactError instanceof Error ? compactError.message : String(compactError);
        }
      }
      if (this._isResponseFormatError(message)) {
        try {
          this._log(
            "[ApiNavigator] response_format rejected; retrying with text and JSON block parsing.",
          );
          const completion = await this.restClient.createChatCompletion({
            messages: buildMessages(body),
            temperature: this.temperature,
            max_tokens: -1,
            response_format: { type: "text" },
            timeoutMs: this.navigationRequestTimeoutMs,
          });
          const raw = completion?.choices?.[0]?.message?.content ?? "";
          return this._parsePlan(raw);
        } catch (retryError) {
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          this._log(`[ApiNavigator] Retry after response_format failure also failed: ${retryMessage}`);
        }
      }
      this._log(`[ApiNavigator] Failed to request navigation hints: ${message}`);
      const fallback = this._buildFallbackPlan(message);
      if (fallback) {
        return fallback;
      }
      if (this._shouldDisable(message)) {
        this._disableNavigator(message);
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

  _disableNavigator(message) {
    this.disabled = true;
    this.disableNotice = {
      feature: "api-navigator",
      reason: this._classifyDisableReason(message),
      message,
      timestamp: new Date().toISOString(),
      emitted: false,
    };
  }

  consumeDisableNotice() {
    if (!this.disableNotice || this.disableNotice.emitted) {
      return null;
    }
    this.disableNotice.emitted = true;
    return this.disableNotice;
  }

  _classifyDisableReason(message) {
    if (!message) {
      return "REST failure";
    }
    const normalized = message.toLowerCase();
    if (normalized.includes("timeout") || normalized.includes("timed out")) {
      return "timeout";
    }
    if (normalized.includes("econnrefused") || normalized.includes("enotfound")) {
      return "connection error";
    }
    if (normalized.includes("network")) {
      return "network error";
    }
    return "REST failure";
  }

  _parsePlan(raw) {
    const parsed = extractJsonBlock(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      this._log("[ApiNavigator] Unable to parse navigation plan: no valid JSON block found.");
      return null;
    }
    if (!parsed.stop_reason && this.lastStopReason) {
      parsed.stop_reason = this.lastStopReason;
    }
    return parsed;
  }

  _buildFallbackPlan(message) {
    const reason = this._classifyDisableReason(message);
    this.lastStopReason = reason;
    return {
      schema_version: "navigation-plan@fallback",
      navigation_summary: `Navigator unavailable (${reason})`,
      recommended_paths: [],
      file_types: [],
      focus_commands: [],
      actions: [],
      helper_script: null,
      notes: message ?? null,
      stop_reason: reason,
    };
  }

  _isResponseFormatError(message) {
    if (!message) return false;
    const normalized = message.toString().toLowerCase();
    return (
      normalized.includes("response_format") ||
      normalized.includes("json_schema") ||
      normalized.includes("json object")
    );
  }

  async _materializeHelperScript(definition, payload) {
    if (!definition?.code) {
      return null;
    }
    const helperCode = this._sanitizeHelperCode(definition.code);
    if (!helperCode) {
      this._log("[ApiNavigator] Helper script contained no runnable code; skipping execution.");
      return null;
    }
    const record = await this.memory.recordHelperScript({
      name: definition.name ?? "api-navigator-helper",
      description: definition.description ?? null,
      language: definition.language ?? "node",
      code: helperCode,
      source: "api-navigator",
      objective: payload.objective ?? null,
      workspaceType: payload.workspace?.classification?.label ?? null,
      notes: definition.notes ?? null,
      stdin: definition.stdin ?? null,
    });
    if (!record) {
      return null;
    }
    let runRecord = null;
    const stdinPayload =
      definition.stdin !== undefined && definition.stdin !== null
        ? definition.stdin
        : payload.cwd
          ? `${payload.cwd}\n`
          : null;
    const execution = await this._executeHelper(record.path, definition.language, payload.cwd, stdinPayload);
    if (execution) {
      const summaryBase = this._summarizeHelperOutput(execution.stdout, execution.stderr);
      const summary = execution.silenceExceeded
        ? [summaryBase, "terminated after silence timeout"].filter(Boolean).join(" | ")
        : summaryBase;
      runRecord = await this.memory.recordHelperScriptRun({
        id: record.entry.id,
        command: execution.command,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        summary,
        durationMs: execution.durationMs ?? null,
        timeoutMs: this.helperTimeout,
        silenceTimeoutMs: this.helperSilenceTimeout,
        stdin: definition.stdin ?? null,
        silenceExceeded: execution.silenceExceeded,
      });
      if (execution.silenceExceeded) {
        this._log(
          `[ApiNavigator] Helper execution for ${record.entry.name} stopped after silence timeout; review stdout/stderr before reuse.`,
        );
      }
    }
    if (this.globalMemory) {
      try {
        await this.globalMemory.recordHelperSnapshot({
          id: record.entry.id,
          name: record.entry.name,
          description: record.entry.description ?? null,
          workspaceType: payload.workspace?.classification?.label ?? null,
          sourcePath: record.path,
          source: "api-navigator",
          version: record.entry.version ?? null,
        });
      } catch (error) {
        this._log(
          `[ApiNavigator] Failed to mirror helper globally: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return {
      id: record.entry.id,
      name: record.entry.name,
      language: record.entry.language,
      description: record.entry.description ?? null,
      path: record.entry.path,
      absolutePath: record.path,
      version: record.entry.version ?? null,
      stdin: record.entry.stdinExample ?? definition.stdin ?? null,
      run: runRecord,
    };
  }

  async _executeHelper(scriptPath, language, cwd, stdin = null) {
    if (!this.cli) {
      return null;
    }
    const cleanedPath = this._normalizeHelperPath(scriptPath);
    if (!cleanedPath) {
      return null;
    }
    const absolutePath = path.resolve(cleanedPath);
    const normalizedLang = this._normalizeLanguage(language);
    const runner =
      normalizedLang === "python"
        ? await this._resolvePythonRunner()
        : { command: "node", args: ["--experimental-default-type=commonjs"], label: "node" };
    if (!runner?.command) {
      return {
        command: "(python not found)",
        exitCode: -1,
        stdout: "",
        stderr: "Unable to locate a Python interpreter (tried python3, py -3, python, py).",
        durationMs: null,
        silenceExceeded: false,
      };
    }
    const helperArgs = Array.isArray(runner.args) ? [...runner.args] : [];
    const needsQuotes = /\s/.test(absolutePath);
    helperArgs.push(needsQuotes ? this._quoteArg(absolutePath) : absolutePath);
    const command = [runner.command, ...helperArgs].join(" ");
    try {
      const startedAt = Date.now();
      const result = await this.cli.executeCommand(command, {
        cwd: cwd ?? path.dirname(absolutePath),
        timeout: this.helperTimeout,
        maxSilenceMs: this.helperSilenceTimeout,
        stdin,
        captureOutput: true,
      });
      return {
        command,
        exitCode: result.code ?? 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        durationMs: result.durationMs ?? Date.now() - startedAt,
        silenceExceeded: Boolean(result.silenceExceeded),
      };
    } catch (error) {
      return {
        command,
        exitCode: typeof error.code === "number" ? error.code : -1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? (error instanceof Error ? error.message : String(error)),
        durationMs: error?.durationMs ?? null,
        silenceExceeded: Boolean(error?.silenceExceeded),
      };
    }
  }

  async _resolvePythonRunner() {
    const cached = this.pythonRunnerCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.runner;
    }

    const candidates =
      process.platform === "win32"
        ? [
            { command: "python3", probeArgs: ["--version"], runtimeArgs: [], label: "python3" },
            { command: "py", probeArgs: ["-3", "--version"], runtimeArgs: ["-3"], label: "py -3" },
            { command: "python", probeArgs: ["--version"], runtimeArgs: [], label: "python" },
            { command: "py", probeArgs: ["--version"], runtimeArgs: [], label: "py" },
          ]
        : [
            { command: "python3", probeArgs: ["--version"], runtimeArgs: [], label: "python3" },
            { command: "python", probeArgs: ["--version"], runtimeArgs: [], label: "python" },
          ];

    for (const candidate of candidates) {
      const ok = await this._probeExecutable(candidate.command, candidate.probeArgs);
      if (ok) {
        const runner = {
          command: candidate.command,
          args: Array.isArray(candidate.runtimeArgs) ? candidate.runtimeArgs : [],
          label: candidate.label,
        };
        this.pythonRunnerCache = {
          runner,
          expiresAt: Date.now() + PYTHON_RUNNER_CACHE_TTL_MS,
        };
        return runner;
      }
    }

    this.pythonRunnerCache = {
      runner: null,
      expiresAt: Date.now() + PYTHON_RUNNER_CACHE_TTL_MS,
    };
    return null;
  }

  _probeExecutable(command, args) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, PYTHON_RUNNER_CHECK_TIMEOUT_MS);
      const child = spawn(command, args ?? [], { stdio: "ignore" });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error?.code === "ENOENT") {
          resolve(false);
        } else {
          resolve(false);
        }
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
  }

  _normalizeHelperPath(candidate) {
    if (!candidate || typeof candidate !== "string") {
      return "";
    }
    return candidate.trim().replace(/^['"]+|['"]+$/g, "");
  }

  _quoteArg(arg) {
    if (arg === undefined || arg === null) {
      return '""';
    }
    const text = String(arg);
    if (!/[\s"]/g.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, '""')}"`;
  }

  _sanitizeHelperCode(code) {
    if (typeof code !== "string") {
      return "";
    }
    let cleaned = code.trim();
    if (!cleaned) {
      return "";
    }
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[\w-]*\n?/, "").replace(/```$/, "").trim();
    }
    return cleaned;
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
    if (plan.stop_reason) {
      lines.push(`Stop reason: ${plan.stop_reason}`);
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

  _compactText(text, limit = 320) {
    if (!text || typeof text !== "string") {
      return text ?? null;
    }
    const trimmed = text.trim();
    if (!trimmed || trimmed.length <= limit) {
      return trimmed;
    }
    return `${trimmed.slice(0, Math.max(10, limit))}…`;
  }

  _isContextOverflowError(message) {
    if (!message) return false;
    const normalized = message.toString().toLowerCase();
    return (
      normalized.includes("context length") ||
      (normalized.includes("context") && normalized.includes("overflow"))
    );
  }
}
