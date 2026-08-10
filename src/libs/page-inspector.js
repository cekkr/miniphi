import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Two ways to look at an HTML page, because they answer different questions.
 *
 * "As written" reads the file the way a developer reads it: which stylesheets
 * and scripts it pulls in, what the markup skeleton is, which classes the
 * design system uses, which forms exist and what their fields are called. That
 * is the question a model must answer to *reuse* a static template — and it is
 * exactly the question a screenshot cannot answer, because a screenshot cannot
 * show you a class name or an asset path.
 *
 * "As rendered" opens the page in Chromium and reports what is actually on
 * screen: the geometry of each region, which images resolved, which requests
 * failed, what the console said. That is the question a model must answer to
 * know whether the app it just wrote *works* — and it is exactly the question
 * the source cannot answer.
 *
 * The photos-social run had neither. The model was told "use html-template/ as
 * the front-end" and could only `read_file` a 900-line page into a 4k budget,
 * so it never used the template at all and wrote its own markup from memory.
 */

const MAX_TEXT_CHARS = 400;
const MAX_REGION_TEXT_CHARS = 1200;
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_WAIT_MS = 700;
const DEFAULT_TIMEOUT_MS = 30000;
// A region worth a separate vision subtask has to be big enough to see and
// small enough not to be "the whole page again".
const MIN_REGION_AREA_RATIO = 0.02;
// Above this share of the document an element is treated as a layout wrapper
// and opened, not reported. Half the page is the useful line: a main column is
// a container to decompose, a sidebar is a region to describe.
const MAX_REGION_AREA_RATIO = 0.5;
const MAX_REGIONS = 10;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

const SEMANTIC_TAGS = new Set([
  "header",
  "nav",
  "main",
  "aside",
  "footer",
  "section",
  "article",
  "form",
  "dialog",
]);

let puppeteerModule = null;
async function loadPuppeteer() {
  if (!puppeteerModule) {
    puppeteerModule = await import("puppeteer");
  }
  return puppeteerModule?.default ?? puppeteerModule;
}

/** Same loopback-only rule the vision reviewer enforces (see vision-reviewer.js). */
export function normalizeLocalUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ? parsed.href : null;
}

/* ------------------------------------------------------------------ *
 * As written: a tolerant structural read of the HTML source.
 * ------------------------------------------------------------------ */

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

const parseAttributes = (raw) => {
  const attributes = {};
  const pattern = /([:@a-zA-Z_][-:.\w]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match = pattern.exec(raw);
  while (match) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    match = pattern.exec(raw);
  }
  return attributes;
};

/**
 * Builds a shallow element tree from HTML text. Deliberately tolerant and
 * dependency-free: it is used to describe a template's skeleton, not to render
 * it, so an unclosed tag degrades into a slightly wrong nesting rather than an
 * exception.
 */
export function parseHtmlStructure(html) {
  const root = { tag: "#root", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tagPattern = /<(!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\/?[a-zA-Z][^>]*)>/g;
  let cursor = 0;
  let match = tagPattern.exec(html);
  while (match) {
    const between = html.slice(cursor, match.index);
    if (between.trim()) {
      stack[stack.length - 1].text += ` ${collapse(between)}`;
    }
    cursor = match.index + match[0].length;
    const body = match[1];
    if (!body.startsWith("!")) {
      if (body.startsWith("/")) {
        const tag = body.slice(1).trim().toLowerCase();
        for (let index = stack.length - 1; index > 0; index -= 1) {
          if (stack[index].tag === tag) {
            stack.length = index;
            break;
          }
        }
      } else {
        const nameMatch = /^([a-zA-Z][-\w]*)([\s\S]*)$/.exec(body);
        if (nameMatch) {
          const tag = nameMatch[1].toLowerCase();
          const selfClosing = /\/\s*$/.test(nameMatch[2]) || VOID_ELEMENTS.has(tag);
          const node = {
            tag,
            attributes: parseAttributes(nameMatch[2]),
            children: [],
            text: "",
          };
          stack[stack.length - 1].children.push(node);
          if (!selfClosing) {
            stack.push(node);
            if (tag === "script" || tag === "style") {
              // Skip raw text content so `</div>` inside a script does not
              // close a real element.
              const closing = new RegExp(`</${tag}\\s*>`, "i");
              const rest = html.slice(cursor);
              const end = rest.search(closing);
              if (end >= 0) {
                cursor += end + rest.slice(end).indexOf(">") + 1;
                stack.pop();
                tagPattern.lastIndex = cursor;
              }
            }
          }
        }
      }
    }
    match = tagPattern.exec(html);
  }
  const tail = html.slice(cursor);
  if (tail.trim()) {
    stack[stack.length - 1].text += ` ${collapse(tail)}`;
  }
  return root;
}

const findFirst = (node, tag) => {
  if (node.tag === tag) {
    return node;
  }
  for (const child of node.children) {
    const found = findFirst(child, tag);
    if (found) {
      return found;
    }
  }
  return null;
};

const walk = (node, visit, depth = 0) => {
  visit(node, depth);
  for (const child of node.children) {
    walk(child, visit, depth + 1);
  }
};

const nodeLabel = (node) => {
  const id = node.attributes.id ? `#${node.attributes.id}` : "";
  const classes = collapse(node.attributes.class ?? "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .map((name) => `.${name}`)
    .join("");
  return `${node.tag}${id}${classes}`;
};

const directText = (node) => {
  const own = collapse(node.text);
  if (own) {
    return own.slice(0, MAX_TEXT_CHARS);
  }
  const parts = [];
  walk(node, (child) => {
    const text = collapse(child.text);
    if (text) {
      parts.push(text);
    }
  });
  return collapse(parts.join(" ")).slice(0, MAX_TEXT_CHARS);
};

/**
 * Reads one HTML file and returns the structural digest a model needs in order
 * to reuse it: assets, layout outline, repeated component classes, forms,
 * navigation. Bounded so it fits a prompt whole — the whole point is that the
 * model stops trying to `read_file` a 900-line template into a small budget.
 *
 * @param {string} absolutePath
 * @param {{maxOutlineDepth?:number, maxOutlineNodes?:number}} [options]
 */
export async function inspectPageSource(absolutePath, options = undefined) {
  const maxDepth = Number.isFinite(options?.maxOutlineDepth) ? options.maxOutlineDepth : 4;
  const maxNodes = Number.isFinite(options?.maxOutlineNodes) ? options.maxOutlineNodes : 80;
  const html = await fs.readFile(absolutePath, "utf8");
  const root = parseHtmlStructure(html);
  const head = findFirst(root, "head") ?? root;
  const body = findFirst(root, "body") ?? root;

  const stylesheets = [];
  const scripts = [];
  const images = [];
  const forms = [];
  const links = [];
  const classCounts = new Map();
  const outline = [];
  let nodeCount = 0;

  walk(root, (node) => {
    nodeCount += 1;
    if (node.tag === "link" && /stylesheet/i.test(node.attributes.rel ?? "") && node.attributes.href) {
      stylesheets.push(node.attributes.href);
    }
    if (node.tag === "script" && node.attributes.src) {
      scripts.push(node.attributes.src);
    }
    if (node.tag === "img" && node.attributes.src) {
      images.push(node.attributes.src);
    }
    if (node.tag === "a" && node.attributes.href) {
      links.push({ href: node.attributes.href, text: directText(node).slice(0, 80) });
    }
    for (const name of collapse(node.attributes.class ?? "").split(" ").filter(Boolean)) {
      classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
    }
  });

  walk(body, (node) => {
    if (node.tag !== "form") {
      return;
    }
    const fields = [];
    walk(node, (child) => {
      if (!["input", "select", "textarea", "button"].includes(child.tag)) {
        return;
      }
      fields.push({
        tag: child.tag,
        type: child.attributes.type ?? null,
        name: child.attributes.name ?? null,
        placeholder: child.attributes.placeholder ?? null,
      });
    });
    forms.push({
      action: node.attributes.action ?? null,
      method: (node.attributes.method ?? "get").toLowerCase(),
      fields: fields.slice(0, 20),
    });
  });

  walk(body, (node, depth) => {
    if (depth > maxDepth || outline.length >= maxNodes || node === body) {
      return;
    }
    const semantic = SEMANTIC_TAGS.has(node.tag);
    const hasIdentity = Boolean(node.attributes.id || node.attributes.class);
    const container = ["div", "ul", "ol", "li", "table", "h1", "h2", "h3"].includes(node.tag);
    if (!semantic && !(container && hasIdentity)) {
      return;
    }
    outline.push({
      depth,
      selector: nodeLabel(node),
      semantic,
      children: node.children.length,
      text: directText(node).slice(0, 160) || null,
    });
  });

  const byFrequency = [...classCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // `repeatedClasses` is the *prompt-facing* digest: the classes the design
  // reuses are the ones an implementation must copy, and they are few enough to
  // show a model. `classVocabulary` is the *checking* surface — a page built
  // from this template will carry single-use structural classes too, and a
  // fidelity check that ignored them would need an implausibly large overlap
  // before it believed anything.
  const components = byFrequency
    .filter(([, count]) => count >= 2)
    .slice(0, 30)
    .map(([name, count]) => ({ class: name, occurrences: count }));
  const classVocabulary = byFrequency.slice(0, 300).map(([name]) => name);

  return {
    kind: "source",
    path: absolutePath,
    bytes: html.length,
    title: collapse(findFirst(head, "title")?.text ?? "") || null,
    nodes: nodeCount,
    stylesheets: [...new Set(stylesheets)].slice(0, 20),
    scripts: [...new Set(scripts)].slice(0, 20),
    images: [...new Set(images)].slice(0, 30),
    forms,
    navLinks: links.slice(0, 40),
    repeatedClasses: components,
    classVocabulary,
    outline,
  };
}

/* ------------------------------------------------------------------ *
 * As rendered: what Chromium actually shows right now.
 * ------------------------------------------------------------------ */

/**
 * Runs inside the page. Returns the rendered structure plus geometry, so the
 * caller can crop the screenshot per region without guessing where anything is.
 */
/* c8 ignore start - executed in the browser context, not in the test runner */
const RENDERED_DIGEST = function collectRenderedDigest(config) {
  const bounded = (text, limit) =>
    String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const label = (element) => {
    const id = element.id ? `#${element.id}` : "";
    const classes = (element.className && typeof element.className === "string"
      ? element.className.split(/\s+/).filter(Boolean).slice(0, 4)
      : []
    )
      .map((name) => `.${name}`)
      .join("");
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const viewportArea = viewport.width * viewport.height;
  const documentHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body ? document.body.scrollHeight : 0,
    viewport.height,
  );
  // Regions are measured against the whole document, not the viewport. A feed
  // column is legitimately three screens tall; ranking it "larger than the
  // page" and discarding it is how the first version of this returned exactly
  // one region for a real social-network template.
  const documentArea = viewport.width * documentHeight;
  const regions = [];
  const seen = new Set();

  // Descend past wrappers instead of listing them. A modern template nests the
  // whole page inside two or three full-bleed divs with no semantics; matching
  // on tag names or class substrings finds those and misses the actual layout,
  // so the walk keeps opening any element that covers nearly everything.
  const queue = [];
  if (document.body) {
    for (const child of document.body.children) {
      queue.push({ element: child, depth: 0 });
    }
  }
  while (queue.length && regions.length < config.maxRegions * 3) {
    const { element, depth } = queue.shift();
    if (!element || depth > 6 || ["script", "style", "noscript", "template"].includes(element.tagName.toLowerCase())) {
      continue;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (!area) {
      continue;
    }
    const ratio = area / documentArea;
    // `main`, `section` and `article` are containers by definition and are the
    // things that need opening; `header`/`nav`/`aside`/`footer`/`form` are
    // genuine regions even when they are large, so they are never descended
    // into.
    const atomic = ["header", "nav", "aside", "footer", "form"].includes(
      element.tagName.toLowerCase(),
    );
    if (ratio > config.maxRatio && !atomic && element.children.length) {
      for (const child of element.children) {
        queue.push({ element: child, depth: depth + 1 });
      }
      continue;
    }
    if (ratio < config.minRatio && area / viewportArea < config.minRatio) {
      continue;
    }
    const key = label(element) + Math.round(rect.x) + "x" + Math.round(rect.y);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    regions.push({
      selector: label(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      box: {
        x: Math.max(0, Math.round(rect.x)),
        y: Math.max(0, Math.round(rect.y + window.scrollY)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      areaRatio: Number(ratio.toFixed(4)),
      images: element.querySelectorAll("img").length,
      links: element.querySelectorAll("a").length,
      inputs: element.querySelectorAll("input,textarea,select").length,
      buttons: element.querySelectorAll("button,[type=submit]").length,
      text: bounded(element.innerText, config.maxRegionText),
    });
  }
  // Reading order, which is the order the survey prompt asks the model for.
  regions.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);

  const images = [...document.images].slice(0, 40).map((image) => ({
    src: image.currentSrc || image.src,
    loaded: image.complete && image.naturalWidth > 0,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }));
  const stylesheets = [...document.styleSheets]
    .map((sheet) => sheet.href)
    .filter(Boolean)
    .slice(0, 20);
  const forms = [...document.forms].slice(0, 10).map((form) => ({
    action: form.getAttribute("action"),
    method: (form.getAttribute("method") || "get").toLowerCase(),
    fields: [...form.elements]
      .slice(0, 20)
      .map((field) => ({ name: field.name || null, type: field.type || null })),
  }));
  return {
    title: document.title,
    url: location.href,
    viewport,
    documentHeight: document.documentElement.scrollHeight,
    bodyTextLength: (document.body?.innerText ?? "").length,
    styledElements: document.querySelectorAll("[class]").length,
    regions: regions.slice(0, config.maxRegions),
    images,
    stylesheets,
    forms,
    headings: [...document.querySelectorAll("h1,h2,h3")]
      .slice(0, 20)
      .map((node) => ({ tag: node.tagName.toLowerCase(), text: bounded(node.innerText, 120) })),
  };
};
/* c8 ignore stop */

/**
 * An open Chromium page plus everything observed while loading it. Held open on
 * purpose: region crops are taken with `page.screenshot({clip})`, which needs
 * the live page, and re-navigating per region would be both slow and racy.
 */
export class LivePage {
  constructor({ browser, page, target, pageErrors, consoleErrors, failedRequests }) {
    this.browser = browser;
    this.page = page;
    this.target = target;
    this.pageErrors = pageErrors;
    this.consoleErrors = consoleErrors;
    this.failedRequests = failedRequests;
  }

  async digest(options = undefined) {
    const digest = await this.page.evaluate(RENDERED_DIGEST, {
      minRatio: options?.minAreaRatio ?? MIN_REGION_AREA_RATIO,
      maxRatio: options?.maxAreaRatio ?? MAX_REGION_AREA_RATIO,
      maxRegions: options?.maxRegions ?? MAX_REGIONS,
      maxRegionText: options?.maxRegionText ?? MAX_REGION_TEXT_CHARS,
    });
    return {
      kind: "rendered",
      target: this.target,
      ...digest,
      pageErrors: this.pageErrors.slice(0, 10),
      consoleErrors: this.consoleErrors.slice(0, 10),
      failedRequests: this.failedRequests.slice(0, 10),
    };
  }

  /** Full-viewport PNG. */
  async screenshot({ fullPage = false } = {}) {
    const buffer = await this.page.screenshot({ type: "png", fullPage });
    return Buffer.from(buffer);
  }

  /**
   * PNG of one region's box. Returns null when the box is degenerate or the
   * clip falls outside the rendered document, which Chromium rejects.
   */
  async screenshotRegion(box) {
    const width = Math.floor(Number(box?.width) || 0);
    const height = Math.floor(Number(box?.height) || 0);
    if (width < 8 || height < 8) {
      return null;
    }
    try {
      const buffer = await this.page.screenshot({
        type: "png",
        captureBeyondViewport: true,
        clip: {
          x: Math.max(0, Math.floor(Number(box.x) || 0)),
          y: Math.max(0, Math.floor(Number(box.y) || 0)),
          width,
          height,
        },
      });
      return Buffer.from(buffer);
    } catch {
      return null;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

/**
 * Opens a local file or a loopback URL in headless Chromium.
 *
 * `waitUntil` differs by target for the same reason `vision-reviewer.js`
 * distinguishes them: a served page is usually still fetching its own data when
 * `load` fires, and inspecting it then reports an empty app.
 */
export async function openLivePage({
  absolutePath = null,
  url = null,
  viewport = DEFAULT_VIEWPORT,
  waitMs = DEFAULT_WAIT_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedUrl = url ? normalizeLocalUrl(url) : null;
  if (url && !normalizedUrl) {
    throw new Error(`url "${url}" is not an http(s) loopback address`);
  }
  if (!normalizedUrl && !absolutePath) {
    throw new Error("absolutePath or a loopback url is required");
  }
  const target = normalizedUrl ?? pathToFileURL(absolutePath).href;
  const puppeteer = await loadPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    const pageErrors = [];
    const consoleErrors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error).slice(0, 400)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text().slice(0, 400));
      }
    });
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? "failed"}`.slice(0, 300));
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()} ${response.url()}`.slice(0, 300));
      }
    });
    await page.goto(target, {
      waitUntil: normalizedUrl ? "networkidle2" : "load",
      timeout: timeoutMs,
    });
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    return new LivePage({ browser, page, target, pageErrors, consoleErrors, failedRequests });
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** One-shot convenience: open, digest, close. */
export async function inspectPageLive(options = undefined) {
  const live = await openLivePage(options);
  try {
    return await live.digest(options);
  } finally {
    await live.close();
  }
}

/**
 * The action AgentSession wires as `pageInspect`: "as written" for a workspace
 * file, "as rendered" for a loopback URL, and both when a file is given with
 * `mode: "both"` (a static template is legitimately readable either way).
 */
export function createPageInspectAction({ workspaceRoot, logger = null } = {}) {
  const log = typeof logger === "function" ? logger : () => {};
  return async function pageInspectAction({ relativePath = null, url = null, mode = "auto" } = {}) {
    try {
      if (url) {
        const rendered = await inspectPageLive({ url });
        return { ok: true, response: { mode: "rendered", rendered } };
      }
      if (!relativePath) {
        return { ok: false, error: "page_inspect needs a workspace path or a loopback url" };
      }
      const absolute = path.resolve(workspaceRoot, relativePath);
      // A model guessing a template's filename is common and cheap to fix, but
      // only if the answer says what is actually there. Seen live: repeated
      // `page_inspect html-template/login.html` and `register.html` when the
      // files are `form-login.html` and `form-register.html`. "ENOENT" teaches
      // nothing; a directory listing ends it in one turn.
      const source = await inspectPageSource(absolute).catch(async (error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        const siblings = await fs
          .readdir(path.dirname(absolute))
          .then((entries) => entries.filter((entry) => entry.endsWith(".html")).sort())
          .catch(() => []);
        throw new Error(
          siblings.length
            ? `${relativePath} does not exist. The HTML files in ${path.dirname(relativePath) || "."}/ are: ${siblings.join(", ")}. Use one of those exact names.`
            : `${relativePath} does not exist.`,
        );
      });
      if (mode === "source") {
        return { ok: true, response: { mode: "source", source } };
      }
      const rendered = await inspectPageLive({ absolutePath: absolute }).catch((error) => {
        log(`[page-inspect] render of ${relativePath} failed: ${error?.message ?? error}`);
        return null;
      });
      return { ok: true, response: { mode: rendered ? "both" : "source", source, rendered } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export default { inspectPageSource, inspectPageLive, openLivePage, createPageInspectAction };
