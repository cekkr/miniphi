# photos-social — agent handbook

The operational reference for an agent building this sample. Written against the
checked-out revision, following `docs/guidelines/AGENTS.bootstrap.md`.

## Mission and scope

Turn the static design in `html-template/` into a working photo social network,
as a Node.js application living entirely in `server/`.

This is **not** a REST API exercise. An app that answers every documented route
correctly but renders its own markup has failed the task: the design is the
deliverable's front-end, and reproducing it from memory throws away the thing
the operator asked to be used.

`server/` is generated output and is git-ignored. `html-template/` is a
read-only reference. Nothing outside `server/` may be modified.

## Sources of truth, in order

1. This file — the contract for the work.
2. `html-template/*.html` — the design. What a page must look like and which
   classes, assets and form fields it uses.
3. `README.md` — the operator's one-paragraph statement of the sample.
4. The validator's `issues` — the authoritative verdict on whether the app
   works. It runs after every change and its sentences are instructions.

## Principles and contracts

- **Serve the template, do not imitate it.** Each page is built from its
  matching template file: `/feed` from `html-template/home.html`, `/u/:username`
  from `profile.html`, `/login` from `form-login.html`, `/register` from
  `form-register.html`. Validation counts how many of the template's own CSS
  classes appear on each served page and rejects pages that do not use them.
- **Mount the asset tree.** `html-template/assets` must be reachable at the
  paths the markup already references, or every page renders unstyled.
- **SQLite on disk, never in memory.** Tables for users, posts, likes and
  comments in a real database file under `server/`.
- **`node:sqlite` is the driver.** Node 24 is installed here and native addons
  (`better-sqlite3`, `sqlite3`, anything building through node-gyp) cannot
  compile on this host — their build sets an older C++ standard than Node 24's
  headers need, and no prebuilt binary covers Node 24. An `npm install` of one
  of them fails permanently; retrying it cannot succeed. Every other dependency
  must be pure JavaScript.
- **Never list a `node:` builtin in `dependencies`.** It makes `npm install`
  fail for the whole manifest.
- **Listen on `process.env.PORT`** (default 3000). The validator starts the app
  with its working directory set to `server/` and `PORT=3117`.
- **Resolve paths from the module, not the process.** Use
  `new URL("./data/photos.db", import.meta.url)`. SQLite does not create missing
  directories: `mkdir` the database's parent and the uploads directory first.

## HTTP contract

Verified automatically after every change:

| Route | Behaviour |
| --- | --- |
| `GET /health` | 200 `{"status":"ok"}` |
| `GET/POST /register` | form `username`, `email`, `password`; creates the user, sets a session cookie |
| `GET/POST /login` | form `username`, `password`; sets a session cookie |
| `POST /upload` | multipart with an `image` file part and a `caption` field |
| `GET /api/posts` | 200 JSON array, newest first, each with `id`, `caption`, `imageUrl`, `author`; `imageUrl` must fetch 200 |
| `GET /feed` | 200 HTML from the template, every post's caption and photo rendered |
| `GET /u/:username` | 200 HTML profile page from the template |
| `POST /posts/:id/like` | 200 `{"likes": <number>}` |
| `POST /posts/:id/comments` | form `text`; persists the comment |

## Validation

One command decides everything: the sample runner's validator
(`scripts/photos-social/validator.js` in the MiniPhi repository). It boots the
app, drives the whole scenario over real HTTP, inspects the SQLite file, checks
template fidelity, opens `/feed` in a browser, and runs the app's own suite.

**The app must ship its own tests.** `server/package.json` needs a real `test`
script — `node:test` is built in, no dependency required — covering:

- unit tests for the data layer (insert a post, read it back, like it, comment);
- an end-to-end test that starts the app on an ephemeral port and drives the
  real HTTP surface: register → login → upload → `GET /api/posts` → `GET /feed`,
  asserting on status codes and on strings that must appear in the HTML.

Every assertion must be **textual**: an exit code or a named assertion failure.
Screenshots are attachments to a verdict, never the verdict — the suite has to
be readable by a model with no vision at all.

Run it with `npm test` inside `server/`. Validation requires exit code 0.

## Tools worth using here

- `page_inspect` on a template file returns its stylesheets, scripts, image
  paths, forms, layout outline and reused classes as bounded JSON. Use it
  instead of `read_file` — the template pages are far larger than the context
  budget, and their structure is what you need.
- `page_understand` on a template file decomposes it region by region and
  reports what each region contains and which data fields it needs. Use it once
  per page before implementing that page.
- `page_inspect` with the running app's loopback URL reports the live DOM,
  which images loaded and which requests failed — the fastest way to find out
  why a page that "looks right in the markup" renders empty.

## Known gaps

- `server/` starts empty on a clean checkout; everything above describes what
  must be built, not what exists.
- The design template ships no server-side templating: substituting data into
  its markup is part of the work, and how (string replacement, a tiny renderer,
  or building the DOM server-side) is an open choice.
