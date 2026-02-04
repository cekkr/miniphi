import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_UNTIL = "domcontentloaded";
const DEFAULT_MAX_TEXT_CHARS = 20000;

let puppeteerModule = null;

async function loadPuppeteer() {
  if (!puppeteerModule) {
    puppeteerModule = await import("puppeteer");
  }
  return puppeteerModule?.default ?? puppeteerModule;
}

function normalizeWhitespace(text) {
  if (!text) {
    return "";
  }
  return text.replace(/\s+/g, " ").trim();
}

function clampText(text, maxChars) {
  if (!text) {
    return "";
  }
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : null;
  if (!limit || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

export default class WebBrowser {
  constructor(options = undefined) {
    this.browser = null;
    this.headless = options?.headless !== false;
    this.executablePath = options?.executablePath ?? null;
    this.userAgent = options?.userAgent ?? null;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    this.waitUntil = options?.waitUntil ?? DEFAULT_WAIT_UNTIL;
    this.waitForSelector = options?.waitForSelector ?? null;
    this.waitMs = Number.isFinite(options?.waitMs) ? options.waitMs : null;
    this.maxTextChars =
      Number.isFinite(options?.maxTextChars) && options.maxTextChars > 0
        ? Math.floor(options.maxTextChars)
        : DEFAULT_MAX_TEXT_CHARS;
    this.blockResources = options?.blockResources !== false;
    this.viewport = options?.viewport ?? { width: 1280, height: 720 };
    this.screenshotDir = options?.screenshotDir ?? null;
  }

  async open() {
    if (this.browser) {
      return;
    }
    const puppeteer = await loadPuppeteer();
    this.browser = await puppeteer.launch({
      headless: this.headless ? "new" : false,
      executablePath: this.executablePath ?? undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }

  async close() {
    if (!this.browser) {
      return;
    }
    await this.browser.close();
    this.browser = null;
  }

  async fetch(url, options = undefined) {
    const startedAt = Date.now();
    const snapshot = {
      id: randomUUID(),
      url,
      finalUrl: null,
      title: null,
      text: "",
      html: null,
      status: null,
      error: null,
      screenshot: null,
      extractedAt: new Date().toISOString(),
      durationMs: null,
    };

    if (!url || typeof url !== "string") {
      snapshot.error = "invalid-url";
      return snapshot;
    }

    await this.open();
    const page = await this.browser.newPage();
    try {
      if (this.viewport) {
        await page.setViewport(this.viewport);
      }
      if (this.userAgent) {
        await page.setUserAgent(this.userAgent);
      }
      if (this.blockResources) {
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          const type = request.resourceType();
          if (["image", "media", "font"].includes(type)) {
            request.abort();
          } else {
            request.continue();
          }
        });
      }

      const response = await page.goto(url, {
        waitUntil: options?.waitUntil ?? this.waitUntil,
        timeout: options?.timeoutMs ?? this.timeoutMs,
      });
      snapshot.status = response?.status?.() ?? null;
      snapshot.finalUrl = page.url();

      const waitForSelector = options?.waitForSelector ?? this.waitForSelector;
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, {
          timeout: options?.timeoutMs ?? this.timeoutMs,
        });
      }
      const waitMs = Number.isFinite(options?.waitMs) ? options.waitMs : this.waitMs;
      if (waitMs && waitMs > 0) {
        await page.waitForTimeout(waitMs);
      }

      snapshot.title = await page.title();

      const textSelector = options?.textSelector ?? null;
      if (textSelector) {
        const selectedText = await page.$$eval(textSelector, (nodes) =>
          nodes.map((node) => node?.innerText ?? "").join("\n"),
        );
        snapshot.text = selectedText ?? "";
      } else {
        snapshot.text = await page.evaluate(() => document.body?.innerText ?? "");
      }
      snapshot.text = clampText(normalizeWhitespace(snapshot.text), this.maxTextChars);

      if (options?.includeHtml) {
        snapshot.html = await page.content();
      }

      if (options?.screenshot && this.screenshotDir) {
        await fs.promises.mkdir(this.screenshotDir, { recursive: true });
        const fileName = `${snapshot.id}.png`;
        const screenshotPath = path.join(this.screenshotDir, fileName);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        snapshot.screenshot = screenshotPath;
      }
    } catch (error) {
      snapshot.error = error instanceof Error ? error.message : String(error);
    } finally {
      await page.close();
      snapshot.durationMs = Date.now() - startedAt;
    }
    return snapshot;
  }
}

