import readline from "readline";

const VALID_POLICIES = new Set(["ask", "allow", "deny", "session"]);
const VALID_DANGER = new Set(["low", "mid", "high"]);

export function normalizeCommandPolicy(policy) {
  if (!policy) {
    return "ask";
  }
  const normalized = policy.toString().toLowerCase();
  return VALID_POLICIES.has(normalized) ? normalized : "ask";
}

function normalizeDanger(level) {
  if (!level) {
    return "mid";
  }
  const normalized = level.toString().toLowerCase();
  if (VALID_DANGER.has(normalized)) {
    return normalized;
  }
  return "mid";
}

export default class CommandAuthorizationManager {
  constructor(options = undefined) {
    this.policy = normalizeCommandPolicy(options?.policy);
    this.assumeYes = Boolean(options?.assumeYes);
    this.sessionApproved = false;
    this.logger = typeof options?.logger === "function" ? options.logger : null;
  }

  setPolicy(policy) {
    this.policy = normalizeCommandPolicy(policy);
  }

  async ensureAuthorized(command, metadata = undefined) {
    const danger = normalizeDanger(metadata?.danger);
    const context = metadata?.context ?? null;
    if (!command || typeof command !== "string") {
      return true;
    }
    if (this.policy === "allow") {
      return true;
    }
    if (this.policy === "deny") {
      throw new Error(`[MiniPhi] Command denied by policy: ${command}`);
    }
    if (this.policy === "session" && this.sessionApproved) {
      return true;
    }
    if (this.assumeYes) {
      if (this.policy === "session") {
        this.sessionApproved = true;
      }
      return true;
    }
    const approved = await this._promptApproval(command, danger, context);
    if (!approved) {
      throw new Error(`[MiniPhi] Command rejected by operator: ${command}`);
    }
    if (this.policy === "session") {
      this.sessionApproved = true;
    }
    return true;
  }

  async _promptApproval(command, danger, context) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      this._log(
        `[Authorization] Non-interactive terminal detected; rejecting ${command} (danger=${danger}).`,
      );
      return false;
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const contextLines = [];
    if (context?.source) {
      contextLines.push(`source=${context.source}`);
    }
    if (context?.reason) {
      contextLines.push(context.reason);
    }
    if (context?.hint) {
      contextLines.push(context.hint);
    }
    const header = contextLines.length ? ` (${contextLines.join(" | ")})` : "";
    const question = `Authorize command ${JSON.stringify(command)} [danger=${danger}]${header}? (y/N): `;
    const response = await new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase());
      });
    });
    const approved = response === "y" || response === "yes";
    this._log(
      `[Authorization] ${approved ? "Approved" : "Rejected"} command ${command} (danger=${danger}).`,
    );
    return approved;
  }

  _log(message) {
    if (this.logger) {
      this.logger(message);
    }
  }
}
