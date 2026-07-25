import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer";
import AgentSession from "../src/agent/agent-session.js";
import { createHeadlessApprover } from "../src/agent/approvers.js";
import { LMStudioRestClient } from "../src/libs/lmstudio-api.js";
import { fetchModelCatalog, selectBestModelForTask } from "../src/libs/model-catalog.js";
import WebResearcher from "../src/libs/web-researcher.js";
import { createTempWorkspace, removeTempWorkspace } from "./cli-test-utils.js";

const LIVE = process.env.MINIPHI_AGENT_PROJECT_INTEGRATION === "1";
const LIVE_TIMEOUT_MS = 900000;
const LM_REQUEST_TIMEOUT_MS = 120000;
const TASK =
  "Create an HTML page showing a 2D ball bouncing like a thrown basket ball. Use libraries at your choice";

async function createProjectWorkspace() {
  const outputRoot = process.env.MINIPHI_BASKETBALL_OUTPUT?.trim();
  if (!outputRoot) {
    return { workspace: await createTempWorkspace(), persistent: false };
  }
  const root = path.resolve(outputRoot);
  await fs.mkdir(root, { recursive: true });
  const workspace = path.join(
    root,
    `basketball-project-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await fs.mkdir(workspace, { recursive: false });
  return { workspace, persistent: true };
}

async function resolveModel(restClient) {
  const override = process.env.MINIPHI_LIVE_MODEL?.trim();
  if (override) {
    return override;
  }
  const catalog = await fetchModelCatalog({ restClient });
  const best = selectBestModelForTask(catalog.models, { intent: "coding" });
  assert.ok(best?.model?.id, "no coding-capable chat model is available in LM Studio");
  return best.model.id;
}

async function findIndexHtml(workspace) {
  const direct = path.join(workspace, "index.html");
  try {
    await fs.access(direct);
    return direct;
  } catch {
    // Some models put a newly-created site in one shallow project folder.
  }
  const entries = await fs.readdir(workspace, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".miniphi") {
      continue;
    }
    const candidate = path.join(workspace, entry.name, "index.html");
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

async function inspectBasketballProject({ cwd }) {
  const indexPath = await findIndexHtml(cwd);
  if (!indexPath) {
    return {
      valid: false,
      summary: "Basketball page validation failed.",
      issues: [
        "Create an index.html entry point.",
        "Render the simulation in an HTML canvas, directly or through the selected library.",
        "Make the subject visibly and textually a basketball, not a generic ball.",
        "Model gravity so the vertical velocity changes over time.",
        "Give the thrown ball both horizontal and vertical velocity.",
        "Run a continuous browser animation loop.",
        "Draw the basketball in an orange tone with a dark outline or seam detail.",
      ],
    };
  }
  const html = await fs.readFile(indexPath, "utf8");
  const localScripts = Array.from(
    html.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi),
    (match) => match[1],
  ).filter((src) => !/^(?:https?:)?\/\//i.test(src));
  const scriptBodies = [];
  for (const src of localScripts) {
    const absolute = path.resolve(path.dirname(indexPath), src);
    const relative = path.relative(path.dirname(indexPath), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    try {
      scriptBodies.push(await fs.readFile(absolute, "utf8"));
    } catch {
      // Reported by the browser check if the missing script matters.
    }
  }
  const source = [html, ...scriptBodies].join("\n");
  const issues = [];
  if (!/<canvas\b/i.test(html) && !/new\s+Konva\.Stage/i.test(source)) {
    issues.push("Render the simulation in an HTML canvas, directly or through the selected library.");
  }
  if (!/basketball/i.test(source)) {
    issues.push("Make the subject visibly and textually a basketball, not a generic ball.");
  }
  const usesMatterPhysics = /Matter\.Engine\.create|Engine\.create\(\)/i.test(source);
  if (!usesMatterPhysics && !/(?:gravity|(?:d|v)y\s*\+=)/i.test(source)) {
    issues.push("Model gravity so the vertical velocity changes over time.");
  }
  const hasHorizontalVelocity =
    /(?:\b(?:d|v)x\b|velocity\.x|setVelocity\([^)]*\bx\s*:)/i.test(source);
  const hasVerticalVelocity =
    /(?:\b(?:d|v)y\b|velocity\.y|setVelocity\([^)]*\by\s*:)/i.test(source);
  if (!hasHorizontalVelocity || !hasVerticalVelocity) {
    issues.push("Give the thrown ball both horizontal and vertical velocity.");
  }
  if (!/(?:requestAnimationFrame|setInterval)/i.test(source)) {
    issues.push("Run a continuous browser animation loop.");
  }
  if (!/(?:orange|#(?:f[0-9a-f]{2,5}|e[0-9a-f]{2,5}))/i.test(source)) {
    issues.push("Draw the basketball in an orange tone.");
  }
  if (!/(?:stroke|lineTo|bezierCurveTo|Konva\.Line|afterRender)/i.test(source)) {
    issues.push("Give the basketball a dark outline or seam detail.");
  }
  if (
    usesMatterPhysics &&
    !/(?:Matter\.Render|Render\.create|getContext\s*\(|\bctx\.)/i.test(source)
  ) {
    issues.push("Render the Matter.js world or draw the simulated ball onto the canvas every frame.");
  }
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
  const unsafeHeadScript = Array.from(
    head.matchAll(/<script([^>]+src=["']([^"']+)["'][^>]*)>/gi),
    (match) => ({ attributes: match[1], src: match[2] }),
  ).some(
    ({ attributes, src }) =>
      !/^(?:https?:)?\/\//i.test(src) &&
      !/\bdefer\b|type=["']module["']/i.test(attributes),
  );
  if (unsafeHeadScript) {
    issues.push("Defer local scripts placed in <head>, or move them after the canvas element.");
  }
  if (issues.length === 0) {
    issues.push(...(await inspectRuntimeAnimation(indexPath)));
  }
  return {
    valid: issues.length === 0,
    summary:
      issues.length === 0
        ? "Created and browser-validated the animated basketball page."
        : "Basketball page validation found missing behavior.",
    issues,
  };
}

async function inspectRuntimeAnimation(indexPath) {
  const issues = [];
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    const pageErrors = [];
    const failedScripts = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => {
      if (request.resourceType() === "script") {
        failedScripts.push(request.url());
      }
    });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "load", timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const first = await page.screenshot({ type: "png" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = await page.screenshot({ type: "png" });
    if (first.equals(second)) {
      issues.push("The browser rendered two identical frames; make the basketball visibly move over time.");
    }
    if (pageErrors.length) {
      issues.push(`Fix browser JavaScript errors: ${pageErrors.slice(0, 3).join("; ")}`);
    }
    if (failedScripts.length) {
      issues.push(`Fix or remove scripts that failed to load: ${failedScripts.slice(0, 3).join(", ")}`);
    }
  } catch (error) {
    issues.push(`Make the page load successfully in Chromium: ${error instanceof Error ? error.message : error}`);
  } finally {
    await browser.close();
  }
  return issues;
}

async function validateAnimatedPage(indexPath, screenshotPath) {
  const html = await fs.readFile(indexPath, "utf8");
  assert.match(html, /basket|ball/i, "the page should identify or implement a basketball");
  assert.match(
    html,
    /canvas|requestAnimationFrame|@keyframes|matter(?:\.min)?\.js|gsap/i,
    "the page should contain a browser animation mechanism",
  );

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "networkidle2", timeout: 60000 });
    const first = await page.screenshot({ type: "png" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const second = await page.screenshot({ path: screenshotPath, type: "png" });
    assert.equal(
      first.equals(second),
      false,
      "the rendered page should visibly change while the ball animates",
    );
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
  }
}

test(
  "live: creates a researched, animated basketball page from an empty workspace",
  { skip: !LIVE, timeout: LIVE_TIMEOUT_MS },
  async () => {
    const { workspace, persistent } = await createProjectWorkspace();
    const endpoint =
      process.env.LMSTUDIO_REST_URL?.trim() ||
      process.env.MINIPHI_LMSTUDIO_URL?.trim() ||
      "http://127.0.0.1:1234";
    const restClient = new LMStudioRestClient({
      baseUrl: endpoint,
      timeoutMs: LM_REQUEST_TIMEOUT_MS,
    });
    const model = await resolveModel(restClient);
    const researcher = new WebResearcher({ timeoutMs: 20000 });
    const actionResults = [];
    const session = new AgentSession({
      client: restClient,
      cwd: workspace,
      baseDir: path.join(workspace, ".miniphi"),
      sessionId: "basketball-from-scratch",
      model,
      maxTurns: 12,
      sessionDeadline: Date.now() + LIVE_TIMEOUT_MS - 10000,
      requireWebResearch: true,
      maxWebResearchActions: 1,
      initialResearchQueries: [
        "best JavaScript library for a 2D thrown bouncing basketball animation",
      ],
      validateWorkspace: inspectBasketballProject,
      approver: createHeadlessApprover({ policy: "allow" }),
      webResearch: (query, options) => researcher.search(query, options),
    });
    session.on("status", ({ turn, summary }) => {
      console.log(`[basketball-live] turn ${turn}: ${summary}`);
    });
    session.on("action-result", (result) => {
      actionResults.push(result);
      console.log(
        `[basketball-live] ${result.action?.type ?? "action"}: ${result.status}`,
      );
    });

    try {
      console.log(`[basketball-live] endpoint: ${endpoint}`);
      console.log(`[basketball-live] model: ${model}`);
      console.log(`[basketball-live] workspace: ${workspace}`);
      const result = await session.submitTask(TASK);
      assert.equal(result.status, "completed", `agent stopped with ${result.stopReason}`);
      assert.equal(result.validation?.valid, true, "workspace validation must pass before completion");
      assert.ok(
        actionResults.some(
          (entry) => entry.action?.type === "web_research" && entry.status === "executed",
        ),
        "the project-creation run should exercise web research before choosing a library",
      );
      assert.ok(
        result.edits.some((entry) => entry.status === "written"),
        "the agent should create at least one project file",
      );

      const indexPath = await findIndexHtml(workspace);
      assert.ok(indexPath, "the generated project should contain index.html");
      const screenshotPath = path.join(path.dirname(indexPath), "basketball-page.png");
      await validateAnimatedPage(indexPath, screenshotPath);
      console.log(`[basketball-live] validated page: ${indexPath}`);
      console.log(`[basketball-live] screenshot: ${screenshotPath}`);
    } finally {
      if (!persistent) {
        await removeTempWorkspace(workspace);
      } else {
        console.log(`[basketball-live] preserved workspace: ${workspace}`);
      }
    }
  },
);
