import fs from "fs";
import path from "path";
import MiniPhiMemory from "../libs/miniphi-memory.js";
import WebBrowser from "../libs/web-browser.js";
import { parseNumericSetting, resolveDurationMs } from "../libs/cli-utils.js";

function parseBooleanFlag(value, fallback = undefined) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function collectUrls(options, positionals) {
  const urls = [];
  const pushUrl = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    trimmed
      .split(/[,|]/)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((entry) => urls.push(entry));
  };
  pushUrl(options.url);
  for (const positional of positionals) {
    pushUrl(positional);
  }
  return urls;
}

export async function handleWebBrowse({ options, positionals, verbose, configData }) {
  const urls = collectUrls(options, positionals);
  if (options["url-file"]) {
    const filePath = path.resolve(options["url-file"]);
    const contents = await fs.promises.readFile(filePath, "utf8");
    contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => urls.push(line));
  }

  if (urls.length === 0) {
    throw new Error(
      'web-browse expects at least one URL via --url "<url>" or positional arguments.',
    );
  }

  const browseDefaults = configData?.webBrowse ?? configData?.webbrowse ?? null;
  const timeoutMs =
    resolveDurationMs({
      secondsValue: options.timeout ?? options["timeout-seconds"],
      secondsLabel: "--timeout",
      millisValue: options["timeout-ms"],
      millisLabel: "--timeout-ms",
    }) ??
    (Number.isFinite(browseDefaults?.timeoutMs) ? browseDefaults.timeoutMs : undefined);
  const waitMs =
    parseNumericSetting(options["wait-ms"], "--wait-ms") ??
    (Number.isFinite(browseDefaults?.waitMs) ? browseDefaults.waitMs : undefined);
  const maxTextChars =
    parseNumericSetting(options["max-chars"], "--max-chars") ??
    (Number.isFinite(browseDefaults?.maxChars) ? browseDefaults.maxChars : undefined);
  const headful =
    typeof options.headful === "boolean"
      ? options.headful
      : Boolean(browseDefaults?.headful);
  const includeHtml =
    typeof options["include-html"] === "boolean"
      ? options["include-html"]
      : Boolean(browseDefaults?.includeHtml);
  const screenshotEnabled =
    typeof options.screenshot === "boolean"
      ? options.screenshot
      : Boolean(browseDefaults?.screenshot);
  const userAgent =
    typeof options["user-agent"] === "string"
      ? options["user-agent"]
      : typeof browseDefaults?.userAgent === "string"
        ? browseDefaults.userAgent
        : null;
  const textSelector =
    typeof options.selector === "string"
      ? options.selector
      : typeof browseDefaults?.selector === "string"
        ? browseDefaults.selector
        : null;
  const waitForSelector =
    typeof options["wait-selector"] === "string"
      ? options["wait-selector"]
      : typeof browseDefaults?.waitSelector === "string"
        ? browseDefaults.waitSelector
        : null;
  const waitUntil =
    typeof options["wait-until"] === "string"
      ? options["wait-until"]
      : typeof browseDefaults?.waitUntil === "string"
        ? browseDefaults.waitUntil
        : undefined;
  const blockResources =
    parseBooleanFlag(options["block-resources"], undefined) ??
    parseBooleanFlag(browseDefaults?.blockResources, true);
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const memory = new MiniPhiMemory(cwd);
  await memory.prepare();
  const shouldSave = !options["no-save"];
  const screenshotDir =
    screenshotEnabled
      ? path.resolve(
          options["screenshot-dir"] ??
            browseDefaults?.screenshotDir ??
            path.join(memory.baseDir, "web", "screenshots"),
        )
      : null;

  const browser = new WebBrowser({
    headless: !headful,
    timeoutMs,
    waitUntil,
    waitMs,
    waitForSelector,
    maxTextChars,
    userAgent,
    blockResources,
    screenshotDir,
  });

  try {
    for (const url of urls) {
      if (verbose) {
        console.log(`[MiniPhi][Web] Loading ${url}...`);
      }
      const snapshot = await browser.fetch(url, {
        includeHtml,
        screenshot: screenshotEnabled,
        textSelector,
        waitForSelector,
        waitUntil,
        timeoutMs,
        waitMs,
      });
      if (snapshot.screenshot) {
        snapshot.screenshot =
          path.relative(memory.baseDir, snapshot.screenshot) || snapshot.screenshot;
      }
      if (shouldSave) {
        await memory.saveWebSnapshot(snapshot);
      }
      const statusLabel =
        snapshot.status !== null && snapshot.status !== undefined ? ` [${snapshot.status}]` : "";
      const titleLabel = snapshot.title ? ` - ${snapshot.title}` : "";
      const errorLabel = snapshot.error ? ` (error: ${snapshot.error})` : "";
      console.log(`[MiniPhi][Web] ${snapshot.url}${statusLabel}${titleLabel}${errorLabel}`);
    }
  } finally {
    await browser.close();
  }
}
