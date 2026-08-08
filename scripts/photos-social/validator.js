import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { screenshotTarget } from "../../src/libs/vision-reviewer.js";

/**
 * Workspace validator for the `samples/photos-social` sample.
 *
 * This is instrumentation, not product code: it is the "unit tests step by step"
 * the sample README asks for, run after every agent turn that changed files.
 * It boots the app the agent wrote, exercises the contract over real HTTP,
 * renders the result in Puppeteer, and (when a vision model is wired in) asks a
 * VLM whether the rendered feed actually *looks* like a photo social feed —
 * which is the one check no status code or regex can make.
 *
 * Every failure becomes one imperative sentence in `issues`. Those sentences go
 * straight back into the agent's context, so they are written as instructions
 * ("Serve GET /health ..."), never as diagnostics ("health check failed").
 */

const DEFAULT_PORT = 3117;
const BOOT_TIMEOUT_MS = 45000;
const REQUEST_TIMEOUT_MS = 20000;
const SHUTDOWN_GRACE_MS = 4000;
const MAX_ISSUE_CHARS = 700;
const MAX_LOG_CHARS = 1200;
// A 500 body usually *is* the diagnosis (Express prints the stack). 200 chars cut
// `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string. Received`
// exactly before the part naming what it received.
const RESPONSE_EXCERPT_CHARS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The line of stderr that names the cause, not the last line of the stack.
 *
 * A Node boot failure puts the diagnosis first (`Cannot find package 'hono'`,
 * `SyntaxError: ...`) and a stack trace after it. Reporting the *tail* — which
 * is the obvious thing to do and what this validator did — hands the model
 * `"orted from /Users/..."`: a truncated file path with the cause cut off, from
 * which nothing can be inferred.
 */
export const explainStderr = (stderr, limit = MAX_ISSUE_CHARS) => {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Blacklisting statement keywords does not work: a Node trace shows the
  // *source* that raised the error (`throw new ERR_MODULE_NOT_FOUND(`,
  // `return new ERR_PACKAGE_PATH_NOT_EXPORTED(`), and every such line contains
  // the error's own name, so any keyword search finds the code before the
  // message. Match the canonical error line's *shape* instead — a name followed
  // by a colon, at the start of the line — and treat everything else as noise.
  const isStack = (line) => /^at\s/.test(line) || /^\^+$/.test(line);
  const isSource = (line) => /\b(?:throw|return)\s+new\s+\w*Error|\($/.test(line);
  const readable = lines.filter((line) => !isStack(line) && !isSource(line));
  const cause =
    readable.find((line) => /^(?:[A-Za-z]*Error\b|Error\s*\[)/.test(line) && line.includes(":")) ??
    readable.find((line) =>
      /Cannot find|Cannot read propert|not found|is not defined|No "exports"|\w+Error:/.test(line),
    );
  return (cause ?? readable.slice(0, 3).join(" | ")).slice(0, limit);
};

const exists = async (target) =>
  fs
    .access(target)
    .then(() => true)
    .catch(() => false);

/**
 * The photo the scenario uploads.
 *
 * A 1x1 pixel would prove the storage path just as well and was the obvious
 * choice — but it is also what the *feed screenshot* then shows, stretched into
 * a flat coloured rectangle, and the vision reviewer correctly reports a feed
 * with no recognizable photo in it. The check is only meaningful if the picture
 * under review is a picture, so the scenario uploads one of the template's own
 * demo photographs and falls back to a small generated PNG only if that sample
 * is missing.
 */
const FALLBACK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SAMPLE_PHOTOS = [
  "html-template/assets/images/demos/photo1.jpg",
  "html-template/assets/images/demos/photo2.jpg",
  "html-template/assets/images/post/post-1.jpg",
];

async function resolveUploadPhoto(workspaceRoot) {
  for (const relative of SAMPLE_PHOTOS) {
    const candidate = path.join(workspaceRoot, relative);
    if (await exists(candidate)) {
      return {
        buffer: await fs.readFile(candidate),
        filename: path.basename(candidate),
        type: relative.endsWith(".png") ? "image/png" : "image/jpeg",
      };
    }
  }
  return { buffer: FALLBACK_PNG, filename: "miniphi.png", type: "image/png" };
}

const portIsFree = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });

const waitForPort = async (port, deadline) => {
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.setTimeout(1500);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) {
      return true;
    }
    await sleep(400);
  }
  return false;
};

/**
 * One cookie jar across the whole scenario. The contract is session-based, so a
 * request that silently drops the cookie must fail the *next* step rather than
 * appear to work — which is what a fresh fetch per call would hide.
 */
class Session {
  constructor(origin) {
    this.origin = origin;
    this.cookies = new Map();
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  _absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const entry of raw) {
      const [pair] = entry.split(";");
      const index = pair.indexOf("=");
      if (index > 0) {
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
  }

  async request(pathname, { method = "GET", body = null, headers = {}, redirect = "follow" } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const cookie = this._cookieHeader();
      const response = await fetch(new URL(pathname, this.origin), {
        method,
        body,
        redirect,
        headers: { ...(cookie ? { cookie } : {}), ...headers },
        signal: controller.signal,
      });
      this._absorb(response);
      const text = await response.text();
      return { ok: response.ok, status: response.status, text, headers: response.headers };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        text: "",
        error: error instanceof Error ? error.message : String(error),
        headers: new Headers(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  json(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

const formBody = (fields) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  return {
    body: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
};

const multipartBody = (fields, file) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  form.set(file.field, new Blob([file.buffer], { type: file.type }), file.filename);
  return { body: form, headers: {} };
};

/**
 * Starts the app and returns a handle that always stops it, including when the
 * process ignores SIGTERM — an orphaned server would hold the port and make
 * every later validation report a boot failure it did not cause.
 */
async function startServer({ serverDir, entry, port, env }) {
  const child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: { ...process.env, ...env, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-MAX_LOG_CHARS * 4);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_LOG_CHARS * 4);
  });
  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const ready = await waitForPort(port, Date.now() + BOOT_TIMEOUT_MS);
  return {
    child,
    ready: ready && !exited,
    exited: () => exited,
    logs: () => ({ stdout: stdout.slice(-MAX_LOG_CHARS), stderr: stderr.slice(-MAX_LOG_CHARS) }),
    async stop() {
      if (child.exitCode !== null || child.signalCode) {
        return;
      }
      child.kill("SIGTERM");
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      while (Date.now() < deadline && child.exitCode === null && !child.signalCode) {
        await sleep(150);
      }
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL");
      }
    },
  };
}

/** Locates the app entry point without forcing one exact filename on the agent. */
async function resolveEntry(serverDir) {
  const manifestPath = path.join(serverDir, "package.json");
  if (await exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const fromStart = String(manifest?.scripts?.start ?? "").match(
        /node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.(?:m?js|cjs))/,
      )?.[1];
      for (const candidate of [fromStart, manifest?.main, "app.js", "server.js", "index.js"]) {
        if (candidate && (await exists(path.join(serverDir, candidate)))) {
          return { entry: candidate, manifest };
        }
      }
      return { entry: null, manifest };
    } catch {
      return { entry: null, manifest: null, manifestBroken: true };
    }
  }
  for (const candidate of ["app.js", "server.js", "index.js"]) {
    if (await exists(path.join(serverDir, candidate))) {
      return { entry: candidate, manifest: null };
    }
  }
  return { entry: null, manifest: null };
}

/**
 * The scenario. Order matters: each step depends on the previous one having
 * really worked, so the first failure is always the root cause rather than a
 * cascade.
 */
async function runScenario(origin, photo) {
  const issues = [];
  const facts = {};
  const session = new Session(origin);
  const stamp = Date.now().toString(36);
  const username = `miniphi_${stamp}`;
  const caption = `MiniPhi validation post ${stamp}`;

  const health = await session.request("/health");
  const healthJson = session.json(health.text);
  if (health.status !== 200 || healthJson?.status !== "ok") {
    issues.push(
      `Serve GET /health so it answers 200 with the JSON body {"status":"ok"}. It answered status ${health.status} with ${JSON.stringify(health.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
    // Without /health nothing else can be trusted to be the app under test.
    return { issues, facts };
  }
  facts.health = true;

  const register = await session.request("/register", {
    method: "POST",
    redirect: "manual",
    ...formBody({
      username,
      email: `${username}@example.com`,
      password: "miniphi-Passw0rd!",
    }),
  });
  if (![200, 201, 302, 303].includes(register.status)) {
    issues.push(
      `Accept POST /register with form fields username, email and password, create the user in SQLite, start a session and answer 200/201 or redirect. It answered status ${register.status} with ${JSON.stringify(register.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
    return { issues, facts };
  }
  facts.registered = username;

  const login = await session.request("/login", {
    method: "POST",
    redirect: "manual",
    ...formBody({ username, password: "miniphi-Passw0rd!" }),
  });
  if (![200, 302, 303].includes(login.status)) {
    issues.push(
      `Accept POST /login with form fields username and password and set a session cookie on success. It answered status ${login.status} with ${JSON.stringify(login.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
    return { issues, facts };
  }
  if (!session.cookies.size) {
    issues.push(
      "Set a session cookie in the response to POST /register or POST /login; the validator received no Set-Cookie header, so no later request can be authenticated.",
    );
    return { issues, facts };
  }
  facts.sessionCookies = [...session.cookies.keys()];

  const upload = await session.request("/upload", {
    method: "POST",
    redirect: "manual",
    ...multipartBody({ caption }, { field: "image", ...photo }),
  });
  if (![200, 201, 302, 303].includes(upload.status)) {
    issues.push(
      `Accept POST /upload as multipart/form-data with an "image" file part and a "caption" text field, store the file and insert the post for the logged-in user. It answered status ${upload.status} with ${JSON.stringify(upload.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
    return { issues, facts };
  }
  facts.uploaded = true;

  const api = await session.request("/api/posts");
  const posts = session.json(api.text);
  if (api.status !== 200 || !Array.isArray(posts)) {
    issues.push(
      `Serve GET /api/posts as 200 with a JSON array of posts, each having id, caption, imageUrl and author. It answered status ${api.status} with ${JSON.stringify(api.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
    return { issues, facts };
  }
  const post = posts.find((entry) => entry && entry.caption === caption);
  if (!post) {
    issues.push(
      `Include the just-uploaded post in GET /api/posts. The caption ${JSON.stringify(caption)} was uploaded but the array of ${posts.length} post(s) does not contain it, so the upload is not being persisted or not being read back.`,
    );
    return { issues, facts };
  }
  for (const field of ["id", "imageUrl", "author"]) {
    if (post[field] === undefined || post[field] === null || post[field] === "") {
      issues.push(
        `Include a non-empty "${field}" on every post returned by GET /api/posts. The uploaded post came back as ${JSON.stringify(post).slice(0, 300)}.`,
      );
    }
  }
  facts.apiPost = post;
  if (issues.length) {
    return { issues, facts };
  }

  const image = await session.request(post.imageUrl);
  if (image.status !== 200) {
    issues.push(
      `Serve the uploaded image at the imageUrl reported by GET /api/posts (${post.imageUrl}). Requesting it answered status ${image.status}.`,
    );
  } else {
    facts.imageServed = post.imageUrl;
  }

  const feed = await session.request("/feed");
  if (feed.status !== 200) {
    issues.push(
      `Serve GET /feed as a 200 HTML page listing the posts newest first. It answered status ${feed.status}.`,
    );
  } else {
    if (!feed.text.includes(caption)) {
      issues.push(
        `Render every post's caption in the GET /feed HTML. The page did not contain the uploaded caption ${JSON.stringify(caption)}.`,
      );
    }
    if (!/<img\b[^>]*\bsrc=/i.test(feed.text)) {
      issues.push(
        "Render each post's photo as an <img src=...> element in the GET /feed HTML; the page contained no image tag at all.",
      );
    }
    facts.feedBytes = feed.text.length;
  }

  const profile = await session.request(`/u/${username}`);
  if (profile.status !== 200 || !profile.text.includes(caption)) {
    issues.push(
      `Serve GET /u/:username as a 200 HTML profile page showing that user's posts. Requesting /u/${username} answered status ${profile.status}${profile.status === 200 ? " without the user's caption on the page" : ""}.`,
    );
  } else {
    facts.profile = true;
  }

  const like = await session.request(`/posts/${post.id}/like`, {
    method: "POST",
    redirect: "manual",
  });
  const likeJson = session.json(like.text);
  if (![200, 201, 302, 303].includes(like.status)) {
    issues.push(
      `Accept POST /posts/:id/like from a logged-in user and answer 200 with JSON {"likes": <count>}. It answered status ${like.status}.`,
    );
  } else if (like.status === 200 && !Number.isFinite(Number(likeJson?.likes))) {
    issues.push(
      `Answer POST /posts/:id/like with JSON containing a numeric "likes" total. It answered ${JSON.stringify(like.text.slice(0, RESPONSE_EXCERPT_CHARS))}.`,
    );
  } else {
    facts.liked = true;
  }

  const comment = await session.request(`/posts/${post.id}/comments`, {
    method: "POST",
    redirect: "manual",
    ...formBody({ text: `validated at ${stamp}` }),
  });
  if (![200, 201, 302, 303].includes(comment.status)) {
    issues.push(
      `Accept POST /posts/:id/comments with a "text" field from a logged-in user and persist the comment. It answered status ${comment.status}.`,
    );
  } else {
    facts.commented = true;
  }

  return { issues, facts };
}

/** Confirms the data really landed in SQLite rather than in process memory. */
async function inspectDatabase(serverDir) {
  const found = [];
  const walk = async (dir, depth) => {
    if (depth > 3) {
      return;
    }
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.(db|sqlite3?)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  await walk(serverDir, 0);
  if (!found.length) {
    return { ok: false, files: [] };
  }
  // Reading the header is enough to prove it is a real SQLite file and not an
  // empty placeholder the app never wrote to.
  const details = [];
  for (const file of found) {
    try {
      const handle = await fs.open(file, "r");
      const buffer = Buffer.alloc(16);
      await handle.read(buffer, 0, 16, 0);
      await handle.close();
      const stat = await fs.stat(file);
      details.push({
        file: path.relative(serverDir, file),
        bytes: stat.size,
        sqlite: buffer.toString("utf8").startsWith("SQLite format 3"),
      });
    } catch {
      details.push({ file: path.relative(serverDir, file), bytes: 0, sqlite: false });
    }
  }
  return { ok: details.some((entry) => entry.sqlite && entry.bytes > 0), files: details };
}

/**
 * Builds the `validateWorkspace` callback AgentSession expects.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot   `samples/photos-social`
 * @param {string} [options.serverDirName] Subdirectory the app must live in.
 * @param {Function} [options.visionReview] The same action wired into the session.
 * @param {string} [options.artifactsDir]  Where screenshots and reports are kept.
 * @param {Function} [options.logger]
 */
export function createPhotosSocialValidator({
  workspaceRoot,
  serverDirName = "server",
  visionReview = null,
  artifactsDir = null,
  logger = null,
  port = DEFAULT_PORT,
  visionMinScore = 45,
  maxVisionOnlyFailures = 3,
} = {}) {
  const serverDir = path.join(workspaceRoot, serverDirName);
  const log = (message) => {
    if (logger) {
      logger(`[photos-social] ${message}`);
    }
  };
  let run = 0;
  let visionOnlyFailures = 0;

  return async function validate() {
    run += 1;
    const started = Date.now();
    const issues = [];
    const report = { run, startedAt: new Date().toISOString(), facts: {} };

    if (!(await exists(serverDir))) {
      return {
        valid: false,
        summary: `The application does not exist yet in ${serverDirName}/.`,
        issues: [
          `Create the Node.js application inside ${serverDirName}/ (package.json plus the server entry point). Nothing exists there yet.`,
        ],
        report,
      };
    }

    const { entry, manifest, manifestBroken } = await resolveEntry(serverDir);
    if (manifestBroken) {
      return {
        valid: false,
        summary: `${serverDirName}/package.json is not valid JSON.`,
        issues: [`Rewrite ${serverDirName}/package.json as valid JSON.`],
        report,
      };
    }
    if (!manifest) {
      issues.push(
        `Add ${serverDirName}/package.json declaring the dependencies and a "start" script that runs the server with node.`,
      );
    }
    if (!entry) {
      return {
        valid: false,
        summary: "No runnable server entry point was found.",
        issues: [
          ...issues,
          `Add the server entry point in ${serverDirName}/ (app.js, server.js or index.js) and point package.json "main"/"start" at it.`,
        ],
        report,
      };
    }
    report.entry = entry;

    const declaredDeps = Object.keys(manifest?.dependencies ?? {});
    // A `node:` builtin listed as a dependency makes `npm install` fail for the
    // whole manifest, so telling the model to "run npm install" is telling it to
    // repeat something that cannot work. Naming the offending entry is the only
    // useful thing to say. Seen live: `node:sqlite` declared as a dependency,
    // two turns spent re-running an install that could never succeed.
    const builtinDeps = declaredDeps.filter((name) => name.startsWith("node:"));
    if (builtinDeps.length) {
      return {
        valid: false,
        summary: `${serverDirName}/package.json declares a Node builtin as a dependency.`,
        issues: [
          ...issues,
          `Remove ${builtinDeps.join(", ")} from the "dependencies" of ${serverDirName}/package.json. Those are built into Node and are not npm packages, so "npm install" fails for the whole manifest while they are listed. Import them directly in code (for example: import { DatabaseSync } from "node:sqlite") and then re-run npm install.`,
        ],
        report,
      };
    }
    const hasModules = await exists(path.join(serverDir, "node_modules"));
    if (declaredDeps.length && !hasModules) {
      return {
        valid: false,
        summary: "Declared dependencies are not installed.",
        issues: [
          ...issues,
          `Run "npm install" inside ${serverDirName}/ with run_cmd. package.json declares ${declaredDeps.join(", ")} but ${serverDirName}/node_modules does not exist, so the server cannot start.`,
        ],
        report,
      };
    }

    if (!(await portIsFree(port))) {
      log(`port ${port} is busy; a previous validation may not have shut down`);
    }

    const server = await startServer({ serverDir, entry, port });
    const origin = `http://127.0.0.1:${port}`;
    try {
      if (!server.ready) {
        const logs = server.logs();
        const exit = server.exited();
        return {
          valid: false,
          summary: "The server did not start listening.",
          issues: [
            ...issues,
            `Make "node ${entry}" start an HTTP server listening on process.env.PORT (the validator sets PORT=${port}) within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s. ${
              exit ? `The process exited with code ${exit.code ?? exit.signal}. ` : ""
            }It failed with: ${explainStderr(logs.stderr)}${
              /unable to open database file|ENOENT|no such file/i.test(logs.stderr)
                ? ` The server is started with its working directory set to ${serverDirName}/, so a relative path like "./data/photos.db" means ${serverDirName}/data/photos.db and "./${serverDirName}/data/photos.db" would be wrong. Resolve paths from the module itself (new URL("./data/photos.db", import.meta.url)) rather than from the process working directory. SQLite also does not create missing directories: create the database file's parent directory, and the uploads directory, with a recursive mkdir before opening or writing.`
                : ""
            }`.slice(0, MAX_ISSUE_CHARS * 2),
          ],
          report: { ...report, logs },
        };
      }

      const scenario = await runScenario(origin, await resolveUploadPhoto(workspaceRoot));
      issues.push(...scenario.issues);
      report.facts = scenario.facts;

      const database = await inspectDatabase(serverDir);
      report.database = database;
      if (!database.ok) {
        issues.push(
          database.files.length
            ? `Persist users, posts and comments in a real SQLite database file under ${serverDirName}/. Files found (${database.files.map((entry) => `${entry.file} ${entry.bytes}B`).join(", ")}) are not readable SQLite databases.`
            : `Persist users, posts and comments in a SQLite database file under ${serverDirName}/ (for example ${serverDirName}/data/photos.db). No SQLite file exists after the scenario ran.`,
        );
      }

      // Rendering is checked only once the API contract holds: a screenshot of
      // a page whose data layer is broken tells the model nothing it does not
      // already know, and each vision call is expensive.
      if (!issues.length) {
        const shots = [];
        for (const [name, pathname] of [
          ["feed", "/feed"],
          ["profile", `/u/${scenario.facts.registered}`],
        ]) {
          const capture = await screenshotTarget({
            url: `${origin}${pathname}`,
            waitMs: 1200,
            viewport: { width: 1280, height: 900 },
          });
          if (!capture.ok) {
            issues.push(
              `Make ${pathname} renderable in a browser: taking a screenshot failed with ${capture.error}.`,
            );
            continue;
          }
          if (capture.pageErrors?.length) {
            issues.push(
              `Fix the JavaScript errors thrown while rendering ${pathname}: ${capture.pageErrors
                .slice(0, 3)
                .join(" | ")
                .slice(0, MAX_ISSUE_CHARS)}`,
            );
          }
          shots.push({ name, pathname, base64: capture.base64 });
          if (artifactsDir) {
            await fs.mkdir(artifactsDir, { recursive: true });
            await fs.writeFile(
              path.join(artifactsDir, `run-${String(run).padStart(3, "0")}-${name}.png`),
              Buffer.from(capture.base64, "base64"),
            );
          }
        }

        if (visionReview && shots.length && !issues.length) {
          const feedShot = shots.find((shot) => shot.name === "feed") ?? shots[0];
          const review = await visionReview({
            url: `${origin}${feedShot.pathname}`,
            focus:
              "Is this a working photo social network feed? It must show at least one photo post with a visible image area, the author's name and the caption, laid out like a social feed rather than an error page, an empty page or unstyled text.",
          });
          report.vision = review?.response ?? { error: review?.error ?? "vision review failed" };
          const score = Number(review?.response?.quality_score);
          if (review?.ok && Number.isFinite(score) && score < visionMinScore) {
            const detail = [
              review.response?.description,
              ...(review.response?.issues ?? []),
              ...(review.response?.suggestions ?? []),
            ]
              .filter(Boolean)
              .join(" ")
              .slice(0, MAX_ISSUE_CHARS);
            visionOnlyFailures += 1;
            // Subjective quality is worth several rounds of iteration and then
            // it is worth none: a vision model has no upper bound on taste, so
            // gating on it forever would keep a functionally complete app from
            // ever finishing. After the allowance it stays in the report as
            // advice instead of as a blocker.
            if (visionOnlyFailures <= maxVisionOnlyFailures) {
              issues.push(
                `Improve how ${feedShot.pathname} actually looks (attempt ${visionOnlyFailures} of ${maxVisionOnlyFailures}). A vision model scored the rendered page ${score}/100 and reported: ${detail}`,
              );
            } else {
              report.visionAdvisory = `scored ${score}/100 after ${visionOnlyFailures} attempts; no longer blocking: ${detail}`;
              log(`vision score ${score}/100 is now advisory only`);
            }
          } else {
            visionOnlyFailures = 0;
          }
        }
      }

      const logs = server.logs();
      if (/\b(Error|TypeError|ReferenceError|SQLITE_ERROR)\b/.test(logs.stderr)) {
        issues.push(
          `Fix the errors the server logged while serving the validation scenario: ${explainStderr(
            logs.stderr,
          )}`,
        );
      }
      report.logs = logs;
    } finally {
      await server.stop();
    }

    report.elapsedMs = Date.now() - started;
    report.issues = issues;
    log(`run ${run}: ${issues.length ? `${issues.length} issue(s)` : "all checks passed"}`);
    if (artifactsDir) {
      await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
      await fs
        .writeFile(
          path.join(artifactsDir, `run-${String(run).padStart(3, "0")}-report.json`),
          JSON.stringify(report, null, 2),
        )
        .catch(() => {});
    }

    return {
      valid: issues.length === 0,
      summary: issues.length
        ? `The photo social network is not working yet (${issues.length} issue(s)).`
        : "The photo social network registers, logs in, uploads, persists to SQLite, serves the feed/profile/API and renders correctly.",
      // A local model cannot act on ten instructions at once; the first few are
      // ordered by dependency, so handing back the whole list every turn just
      // pushes the actionable one out of the context budget.
      issues: issues.slice(0, 4).map((issue) => issue.slice(0, MAX_ISSUE_CHARS)),
      report,
    };
  };
}

export default createPhotosSocialValidator;
