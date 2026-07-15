import readline from "readline";
import { normalizeCommandPolicy } from "../libs/command-authorization-manager.js";

/**
 * Permission decisions returned by an approver.
 * @typedef {{ approved: boolean, scope?: "once"|"session", reason?: string }} ApprovalDecision
 */

/**
 * Headless approver used when MiniPhi runs without the interactive UI. It honors
 * the same command-policy vocabulary (`ask|allow|deny|session`) as
 * {@link CommandAuthorizationManager} but covers file writes and commands alike
 * and returns a decision object (never throws), so the agent loop can record a
 * rejection and keep going. In `ask` mode it prompts on the TTY; a non-TTY in
 * `ask` mode is treated as a rejection (safe default for CI).
 */
export function createHeadlessApprover(options = undefined) {
  const policy = normalizeCommandPolicy(options?.policy);
  const assumeYes = Boolean(options?.assumeYes);
  const logger = typeof options?.logger === "function" ? options.logger : null;
  const prompt = typeof options?.prompt === "function" ? options.prompt : defaultTtyPrompt;
  let sessionApproved = false;

  return async function approve(request) {
    if (policy === "allow" || assumeYes) {
      return { approved: true, scope: "session" };
    }
    if (policy === "deny") {
      return { approved: false, reason: "denied by command policy" };
    }
    if (policy === "session" && sessionApproved) {
      return { approved: true, scope: "session" };
    }
    const answer = await prompt(request);
    if (answer === "session") {
      sessionApproved = true;
      return { approved: true, scope: "session" };
    }
    const approved = answer === "yes";
    if (logger) {
      logger(`[Approver] ${approved ? "approved" : "rejected"} ${describeRequest(request)}`);
    }
    return approved
      ? { approved: true, scope: "once" }
      : { approved: false, reason: "rejected by operator" };
  };
}

/**
 * UI approver: emits a `permission-request` event carrying the request plus a
 * unique id and returns a promise the Ink layer resolves via
 * `session.resolvePermission(id, decision)`.
 */
export function createUiApprover(emitter, { pending } = {}) {
  const store = pending instanceof Map ? pending : new Map();
  let counter = 0;
  const approver = async function approve(request) {
    const id = `perm-${Date.now()}-${(counter += 1)}`;
    return new Promise((resolve) => {
      store.set(id, resolve);
      emitter.emit("permission-request", { id, request });
    });
  };
  approver.pending = store;
  approver.resolve = (id, decision) => {
    const resolver = store.get(id);
    if (!resolver) {
      return false;
    }
    store.delete(id);
    resolver(normalizeDecision(decision));
    return true;
  };
  return approver;
}

function normalizeDecision(decision) {
  if (decision === true) {
    return { approved: true, scope: "once" };
  }
  if (!decision || typeof decision !== "object") {
    return { approved: false, reason: "rejected" };
  }
  return {
    approved: Boolean(decision.approved),
    scope: decision.scope === "session" ? "session" : "once",
    reason: decision.reason ?? null,
  };
}

function describeRequest(request) {
  if (!request || typeof request !== "object") {
    return "action";
  }
  if (request.kind === "command") {
    return `command ${JSON.stringify(request.command ?? "")}`;
  }
  return `${request.type ?? "edit"} ${request.path ?? ""}`.trim();
}

function defaultTtyPrompt(request) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve("no");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const label = describeRequest(request);
  const danger = request?.danger ? ` [danger=${request.danger}]` : "";
  return new Promise((resolve) => {
    rl.question(`Approve ${label}${danger}? (y=once / a=session / N=no): `, (raw) => {
      rl.close();
      const answer = raw.trim().toLowerCase();
      if (answer === "a" || answer === "all" || answer === "session") {
        resolve("session");
      } else if (answer === "y" || answer === "yes") {
        resolve("yes");
      } else {
        resolve("no");
      }
    });
  });
}
