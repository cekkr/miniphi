# Agent navigation rules

Pre-written rules injected into every MiniPhi agent prompt, above the task.

They exist because a local model does not fail for lack of intelligence; it
fails for lack of *procedure*. Given "build this app from this template" it
starts writing an app, because nothing told it that looking first is cheaper
than guessing. Each rule below was written against an observed failure in a real
run, not from general advice.

This file is loaded by `src/libs/project-guidelines.js` and kept small on
purpose: the full construction protocol lives in
[`AGENTS.bootstrap.md`](AGENTS.bootstrap.md) and is used to *generate* a
project's own `AGENTS.md`, which is far too large to resend every turn.

<!-- BEGIN RULES -->
## R1. Orient before you build

Never write the first file of a task from the task description alone. Establish,
in this order: what already exists (`list_dir`, `read_file`), what the project's
own handbook says (`AGENTS.md` at the workspace root, if present), and what the
reference material actually contains. A plan built on an unread reference is a
guess, and it will be wrong in the specific ways that matter.

## R2. A design reference is to be *used*, not imitated

When the task gives you existing assets — an HTML template, a schema, an API
spec, a reference implementation — the deliverable must load or import those
exact files. Re-creating equivalent markup from memory is the single most common
way to deliver something that passes a shallow check and is worthless: it throws
away the design the operator asked you to use. Use `page_inspect` on a template
page to get its structure, stylesheets, classes and forms without reading a
thousand lines, then serve or include the real file.

## R3. Ask what you cannot see

You cannot infer a rendered layout from source, and you cannot infer a class
name from a screenshot. Use `page_inspect` for structure and live state, and
`page_understand` when you need to know what a page *is* — its regions, what
each region is for, and what data each one needs. Do this before implementing a
page, not after it fails.

## R4. Smallest verifiable step

Each turn produces one coherent, complete artifact: one module, one route
group, one migration. A turn's output is capped; a file that exceeds it is
truncated and rejected, and the rejection reads like a syntax error you did not
make. If a file is long, split it — several small modules always beat one large
one here.

## R5. Never repeat a rejected action

A duplicate, a skipped action or a failed anchor means the loop already told you
something. Read the feedback, change the approach, and move. Re-sending
byte-identical content is the clearest way to burn a run.

## R6. Validate with something executable

Write the test with the code, not after it. Every unit of behavior you add gets
a unit test that fails before and passes after, run by one documented command.
When the deliverable has a user-facing surface — HTTP app, CLI, GUI, rendered
page — add an automated end-to-end check that drives that real surface
(Puppeteer/Playwright/Selenium for a page, a request scenario for an HTTP API, a
real invocation for a CLI).

Every check must produce a **textual verdict**: an exit code, a named assertion,
a JSON report. A screenshot is not a verdict — it is unreadable to a model
without vision and unreliable to compare even with one. Where the property is
visual, assert the extractable facts that stand for it: the expected elements
are in the DOM, the image URL returned 200 with a non-zero body, the layout has
non-zero width, the console emitted no error. Attach the screenshot to that
verdict; never substitute it for one.

Keep the suite fast and runnable from one command with no manual setup. Anything
that cannot meet that bar goes in a separately named slower target.

## R7. Report the truth

Say what you ran, what passed, what you skipped, and what is still broken. A
`finish` on top of a failing validator wastes the whole run, because the only
thing anyone learns from it is that the summary cannot be trusted.

## R8. Record what you learned

When a failure teaches something that is not obvious from the code — a package
that cannot build on this host, an API that behaves unlike its documentation, a
constraint discovered the hard way — record it as a durable note so the next
turn and the next run do not rediscover it.
<!-- END RULES -->
