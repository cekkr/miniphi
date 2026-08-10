<!--
Vendored copy. Upstream: https://github.com/cekkr/ai-agents-bootstrap (AGENTS.bootstrap.md).

Kept in-tree so MiniPhi works offline and for people who do not have that
repository checked out. Point `$MINIPHI_AGENTS_BOOTSTRAP` at your own working
copy to override it. The only MiniPhi-authored content is the clearly marked
"MiniPhi Addendum: Validation-First Delivery" section at the end; keep the rest
in sync with upstream rather than editing it here.

Applied by `miniphi bootstrap-agents` (src/libs/agents-bootstrapper.js), one
section at a time — it is far too large to send whole to a local model.
-->

# AGENTS.md Bootstrap Protocol

Use this document to create or repair the root `AGENTS.md` of any software, hardware, research, data, infrastructure, documentation, or mixed repository.

This is a construction protocol, not project content. Do not copy it unchanged into a repository and call the work complete. Investigate the repository, replace generic instructions with verified project-specific facts, and leave an `AGENTS.md` that describes the checked-out revision precisely.

## Normative Language

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are deliberate:

- **MUST / MUST NOT**: required for a trustworthy `AGENTS.md`.
- **SHOULD / SHOULD NOT**: expected unless a project-specific reason is recorded.
- **MAY**: optional and context-dependent.

When a fact cannot be established, the agent MUST write `Unknown — verify before changing <area>` or omit the claim. It MUST NOT guess.

## Purpose of AGENTS.md

`AGENTS.md` is the repository's current operational map for AI agents. It MUST let a new agent answer, without repeating a repository-wide investigation:

1. What is this project, and what is it explicitly not?
2. Which principles and invariants must every change preserve?
3. Which documents, code, tests, schemas, and commands are authoritative?
4. Where does each major responsibility live?
5. How does control and data flow through the system?
6. How is the project built, run, tested, debugged, packaged, and released?
7. Which behavior is shipped, experimental, generated, deprecated, or only planned?
8. What must be checked before editing and before committing?
9. Which features span multiple files, and which recurring mistakes or bug patterns must not be reintroduced?

`AGENTS.md` is NOT:

- a copy of the README;
- a chronological changelog;
- a dump of every implementation detail;
- a backlog with current behavior mixed into future wishes;
- a place for secrets, tokens, private keys, credentials, or personal data;
- a substitute for tests, architecture decisions, or user documentation.

It is a high-signal index that links those sources and records the contracts an agent is most likely to violate accidentally.

## Authority and Conflict Resolution

The repository's `AGENTS.md` MUST state its source-of-truth order. Unless the project defines a stricter order, use this default:

1. Explicit legal, safety, security, privacy, and product-principle documents.
2. Executable specifications, schemas, migrations, public protocol/API contracts, and tests.
3. Current source code and build/deployment configuration.
4. User/operator documentation such as `README.md`.
5. Roadmaps, issue lists, optimization files, and design notes for planned work.
6. Historical notes and commit messages.

Rules for conflicts:

- Running code does not automatically override a normative safety, privacy, or product principle; the code may be wrong.
- A roadmap does not prove that a feature exists.
- A README does not prove that a command still works.
- A test does not prove more than the behavior it actually asserts.
- A comment does not override executable behavior unless the comment is identified as a normative contract.
- When sources disagree, the agent MUST inspect the relevant behavior, report or fix the mismatch within task scope, and update stale documentation in the same change.
- If the conflict cannot be resolved safely, the agent MUST record it as an explicit gap and ask for direction instead of silently choosing a side.

## Scope and Inheritance

Before editing any file, the agent MUST locate every applicable instruction file from the repository root down to that file's directory.

- The root `AGENTS.md` owns project-wide identity, principles, architecture, commands, and shared contracts.
- A nested `AGENTS.md` MAY add local instructions for a subsystem, generated tree, language, target, or deployment.
- A nested file MUST NOT repeat the entire root handbook. It SHOULD document only local ownership, commands, constraints, and exceptions.
- The root source map MUST link important nested instruction files and state their scope.
- If nested instructions conflict with root instructions, the more specific instruction applies only inside its stated scope unless it violates a higher-authority safety/legal/product contract.

For monorepos, the root handbook MUST explain package boundaries and shared tooling. Each independently built, deployed, versioned, or governed package SHOULD have a scoped handbook.

## Mandatory Discovery Pass

An agent MUST NOT write or substantially revise `AGENTS.md` from the README alone. It MUST inspect the repository first.

### 1. Establish repository state

Inspect:

- working tree status and current branch;
- tracked versus ignored files;
- repository roots, submodules, workspaces, and nested instruction files;
- recent changes when they clarify current direction;
- generated/runtime directories that must not be edited or committed.

Preserve unrelated user changes. Never use destructive cleanup merely to make discovery easier.

### 2. Locate authoritative documents

Search for and read the relevant portions of:

- README, contribution, architecture, principles, security, privacy, support, and license documents;
- roadmap, TODO, optimization, performance, research, and ADR/RFC directories;
- environment examples and deployment/operator guides;
- API/protocol specifications, schemas, migrations, and compatibility policies;
- existing `AGENTS.md`, `CLAUDE.md`, or other agent instructions.

The final handbook MUST link these documents and describe what authority each one carries.

### 3. Derive the real project tree

Use the filesystem and version-control index, not memory. Identify:

- entry points and bootstrap code;
- application, domain, infrastructure, interface, and shared layers;
- libraries, packages, plugins, extensions, workers, tools, scripts, examples, fixtures, and generated artifacts;
- tests and their helpers;
- build, package, CI, deployment, release, and migration files;
- assets, templates, localization, configuration, and runtime-state locations.

For large repositories, inspect imports/exports, route/command registries, manifests, target definitions, and test names to establish ownership. Directory names alone are not enough.

### 4. Verify executable workflows

Read commands from manifests, build files, CI, scripts, and operator docs. Verify the commands that are safe and relevant to the current task.

Never invent a build flag, environment variable, executable, test count, port, dependency version, or release step. If a command cannot be run, state why and identify its source.

### 5. Extract invariants and dangerous boundaries

Find the rules most likely to be broken by an adjacent edit, including:

- authentication, authorization, bootstrap, role, and tenancy boundaries;
- privacy, retention, encryption, signing, secret, and identity rules;
- persistence, migration, consistency, replication, cache, and generated-data rules;
- API, wire format, ABI, file format, schema, and backwards-compatibility contracts;
- concurrency, ownership, lifecycle, resource, and platform constraints;
- UI rendering, accessibility, localization, navigation, and error-state requirements;
- plugin/extension loading and trust boundaries;
- performance budgets and required observability.

Each critical contract SHOULD link both its enforcing implementation and its focused tests.

### 6. Inventory features and recurring failure modes

Trace meaningful features from their public entry points through their owners and tests. Inspect regression test names, focused comments, issue/roadmap references, and relevant history when they explain a non-obvious implementation rule.

Record durable lessons, not incident chronology. A past bug is relevant when its cause is still easy to reintroduce, its fix establishes a reusable pattern, or its regression test is otherwise hard to discover. Verify that an alleged bug or workaround still applies to the checked-out revision before documenting it.

## Required AGENTS.md Structure

Every root `AGENTS.md` MUST contain the sections below. Rename headings to fit the project, but do not omit the information. A section MAY say “Not applicable” with a reason when the category genuinely does not exist.

### 1. Title and mission

Start with a project-specific title and a short statement that this is the fast-access operational reference for agents.

State:

- the project's real name and purpose;
- its current maturity or operational status;
- what adjacent concept, legacy name, optional bundle, prototype, or future vision must not be confused with the product.

### 2. Read order and sources of truth

List the authoritative documents in order. Link each one and say what it governs. Do not provide a pile of unexplained filenames.

### 3. Collaboration and maintenance rules

Define:

- documentation synchronization requirements;
- test expectations;
- generated/runtime file handling;
- dirty-tree preservation;
- optimization/research/backlog recording rules;
- any required branch, commit, release, or naming conventions.

### 4. Essential project principles

Record the few non-negotiable principles that decide architecture and product behavior. Explain their implementation consequences.

Good principle:

> Offline operation is a first-class mode; network features must degrade without blocking local edits.

Weak statement:

> The application should be robust.

Principles MUST be concrete enough to reject an incorrect implementation.

### 5. Critical implementation contracts

Record named invariants with links to symbols/files and tests. Use direct language such as:

- “All provider-admin routes MUST call `canAdministerProvider`; moderator checks are insufficient.”
- “Signing environment variables contain PEM text, never paths.”
- “Database schema changes require an idempotent migration and restart coverage.”

Do not hide critical contracts inside a general source-tree description.

### 6. Architecture and data/control flow

Show the shortest useful paths through the system, for example:

`entry point` → `router` → `controller` → `domain service` → `persistence interface` → `adapter`

Describe process boundaries, external services, asynchronous workers, plugins, generated-code stages, storage ownership, and trust boundaries where present.

Use a diagram only when it makes relationships clearer than a short flow.

### 7. Linked source tree and file reference

This section is mandatory and MUST use clickable relative Markdown links. It MUST be a navigable file reference, not a bulleted inventory of paths.

Every meaningful file MUST have its own linked third-level heading. The description and symbol list belong under that heading so an agent can search for a filename, understand a snippet, and identify the correct edit point without inferring ownership from a directory name.

Preferred format:

```markdown
### [`src/runtime/executor.c`](src/runtime/executor.c)

Executes decoded programs and owns call frames and trap propagation. Change this file for runtime execution semantics; parser code MUST NOT mutate the state owned here.

- **Key functions and subparts:**
  - `execute_program` — drives the instruction loop.
  - `push_frame` — validates and creates call frames.
  - `raise_trap` — normalizes runtime failures.
- **Called by / depends on:** [`src/runtime/runtime.c`](src/runtime/runtime.c) creates the execution context; decoded instructions come from [`src/parser/decoder.c`](src/parser/decoder.c).
- **Tests:** [`tests/runtime/test_executor.c`](tests/runtime/test_executor.c) covers frame lifetime and trap propagation.
- **Common mistakes:** Do not bypass `raise_trap` by returning parser errors directly; doing so loses runtime location data.
```

Each file subsection MUST answer, when applicable:

- What responsibility does this file own, and what does it explicitly not own?
- Which changes belong here?
- Which meaningful functions, classes, types, constants, registrations, phases, or internal subparts help an agent locate behavior? Explain what each one does; do not merely copy a symbol list.
- What calls, imports, generates, configures, or otherwise depends on it?
- Where are its focused tests, fixtures, schemas, or generated outputs?
- What snippet-level misunderstanding, ordering rule, side effect, or tempting wrong edit commonly causes a regression here?

Rules:

- Do not use bullets as the list of files. Start each meaningful file with `### [`path/to/file`](path/to/file)` and use bullets only for details inside that file's subsection.
- Link real tracked files or directories. Use code formatting without a link for generated/runtime paths that are intentionally untracked.
- Do not use a non-clickable code-fenced tree as the only source map.
- Do not write only “contains utilities” or “handles business logic.” Name the responsibilities and the code landmarks that implement them.
- Include all meaningful public and private symbols or subparts needed to navigate the file. Omit trivial accessors, mechanical wrappers, and repetitive helpers unless they carry a contract or are easy to misuse.
- Keep symbol descriptions synchronized with renames and refactors. Never invent a symbol from its likely name; verify it in the checked-out source.
- For a small repository, describe every meaningful source, test, build, configuration, schema, migration, and automation file.
- For a large repository, give individual subsections to every entry point, registry, boundary, hotspot, and non-obvious owner. A linked directory subsection MAY summarize repetitive leaf files only when it names the grouping rule, important exceptions, and the files that require their own subsections.
- Link nested `AGENTS.md` files where local rules apply.
- Remove or update subsections in the same change that moves, renames, splits, or deletes code.

### 8. Features and recurring development pitfalls

Provide a project-wide map of behavior and hard-won implementation knowledge. This section complements the per-file reference: it explains features that cross files and mistakes that recur across tasks or are likely when prior context is absent.

Give each meaningful feature its own `###` heading and record:

- its user- or operator-visible behavior and current status (`Shipped`, `Experimental/scaffold`, `Known gap`, or `Planned`);
- its entry point and main control/data path;
- its owning files and key symbols;
- its configuration, persistence, security, compatibility, or platform constraints;
- its focused tests and known gaps.

Give each recurring error, bug pattern, or confusing implementation detail its own `###` heading and record:

- the observable symptom or incorrect assumption;
- the underlying cause and the invariant that prevents it;
- the files and symbols where the mistake is commonly introduced;
- the safe implementation pattern and the focused test or command that detects regression;
- whether it is an active known bug, a deliberate limitation, or a previously fixed failure mode that remains a regression risk.

Do not turn this section into a chronological bug log. Consolidate repeated incidents into the current rule. Active defects MUST also appear under `Known Gaps`; fixed bugs belong here only when they reveal a non-obvious, reusable lesson that a future agent could otherwise repeat.

### 9. Interface ownership map

Include the public surfaces relevant to the project:

- HTTP routes and controllers;
- CLI commands and handlers;
- library APIs and primary modules;
- protocols/messages and codecs;
- GUI screens and controllers;
- hardware modules/interfaces;
- datasets/pipelines and producers;
- plugin hooks and registries.

The authoritative registry or manifest MUST be linked. Do not duplicate enormous generated API references; map surfaces to owners.

### 10. Build, run, test, debug, and release checklist

Commands MUST be exact, copyable, and taken from current project configuration.

Include as applicable:

- prerequisites and supported platforms;
- dependency/bootstrap command;
- development run command;
- production or packaged build command;
- focused and full test commands;
- lint, format, typecheck, static analysis, benchmark, and security checks;
- fixture/seed/simulation commands;
- debug and inspection tools;
- migration, packaging, release, and deployment commands;
- optional external-service tests and the variables that enable them.

State which commands mutate data, need credentials, require hardware, or contact external systems.

### 11. Test ownership map

Map each critical subsystem and contract to focused tests. Mention shared fixtures and helpers. Record known test gaps explicitly.

Do not hard-code a total test count unless a tool generates and verifies that count automatically; manual counts become stale.

### 12. Data, security, privacy, and compatibility boundaries

State, when applicable:

- canonical versus derived/generated/cache data;
- local versus replicated/public data;
- migration and rollback requirements;
- secret and credential handling;
- validation and trust levels;
- compatibility promises and deprecation policy;
- backup/restore expectations;
- inputs that require limits, sanitization, or signature verification.

Do not expose real secret values in examples.

### 13. Current status, known gaps, and roadmap snapshot

Separate these labels visibly:

- **Shipped:** verified current behavior.
- **Experimental/scaffold:** present but incomplete or unsafe for production claims.
- **Known gap:** missing or contradictory behavior that affects work now.
- **Planned:** roadmap intent with no claim of implementation.

Link the detailed roadmap/backlog instead of copying it wholesale. Keep only priorities that help an agent make the next correct architectural decision.

### 14. Task start and handoff checklist

End with a short checklist that forces the next agent to inspect ownership, principles, data boundaries, focused tests, documentation impact, and validation before changing code.

## Precision Rules

Every project `AGENTS.md` MUST follow these writing rules:

- Use present tense for current behavior and future tense or explicit `Planned` labels for unimplemented work.
- Use imperative language for requirements. Avoid “consider,” “maybe,” “ideally,” or “should probably” unless the choice is genuinely optional and its tradeoff is stated.
- Name the exact symbol, file, route, command, schema, environment variable, or test that enforces a rule.
- Give every meaningful file its own linked `###` subsection in the source reference; never flatten file descriptions into an inventory bullet list.
- Within each file subsection, name and explain the meaningful functions, classes, types, registrations, phases, and other code landmarks needed to find behavior or interpret snippets safely.
- Make every repository path in reference sections a relative Markdown link when it is tracked and linkable.
- Define acronyms and project-specific vocabulary on first use.
- Distinguish user-facing terminology from internal/legacy names.
- State exceptions next to the rule they modify; do not hide exceptions in a later section.
- State negative boundaries: what MUST NOT happen, what data MUST NOT move, and what subsystem MUST NOT own a responsibility.
- Prefer one authoritative owner over duplicated instructions. Link to detail rather than copying volatile material.
- Keep examples clearly marked as examples. Never let placeholder content look like a real default, credential, endpoint, or supported configuration.
- Use dates, versions, performance numbers, platform claims, and status labels only when verified from a source that will be maintained.
- Describe why a non-obvious rule exists when removing it would create a serious regression.

## Update Protocol: Task by Task

At the start of every task, the agent MUST:

1. Read every applicable `AGENTS.md` completely.
2. Check repository status and preserve unrelated changes.
3. Identify the owning source paths and focused tests from the source map.
4. Read the relevant principle, contract, schema, roadmap, or security document.
5. Compare the handbook's claim with current code before relying on it.
6. Check the relevant feature path and recurring pitfalls before changing behavior.
7. Note which handbook sections may change as a result of the task.

At the end of every task, the agent MUST:

1. Update every handbook fact changed or discovered by the task, including affected file symbols, feature paths, and reusable failure-prevention guidance.
2. Remove stale instructions made false by the change.
3. Update human docs, roadmap, ADRs, schemas, or optimization logs when their governed facts changed.
4. Validate commands/links touched by the task.
5. Report tests run, tests not run, and remaining gaps accurately.

A task that changes no durable project knowledge does not require cosmetic handbook churn. A bug fix that reveals a reusable invariant, hidden owner, non-obvious failure mode, or missing test route DOES require an update.

## Update Protocol: Edit by Edit

An edit that changes a documented fact MUST update `AGENTS.md` in the same coherent edit batch. Do not defer documentation repair to an unspecified later cleanup.

| Change made | Mandatory handbook update |
| --- | --- |
| Add, move, split, rename, or delete source | Add, move, rewrite, or remove its linked file subsection; update ownership, meaningful symbols/subparts, callers, tests, and file-specific mistakes. |
| Add or substantially change a meaningful function, class, type, registration, phase, or other code landmark | Update the owning file subsection when the landmark helps locate behavior, carries a contract, or is easy to misuse. |
| Add or change an entry point, route, command, screen, API, protocol message, plugin hook, or hardware interface | Update the interface ownership map and relevant contract. |
| Add or materially change a feature | Update the feature map with its status, path, owners, constraints, tests, and known gaps. |
| Change project identity, terminology, product scope, or principle | Update mission/principles and synchronize public docs. |
| Add a configuration key, environment variable, feature flag, dependency, platform, or prerequisite | Update configuration and build/run instructions. |
| Change authorization, privacy, security, signing, trust, or retention behavior | Update critical contracts and data/security boundaries; link focused tests. |
| Change persisted state, schema, file/wire format, migration, cache, or replication | Update data flow, compatibility rules, migration commands, and restart/round-trip tests. |
| Change concurrency, lifecycle, ownership, resource, or performance assumptions | Update critical contracts, architecture flow, and benchmark/observability guidance. |
| Add, move, or remove tests/fixtures | Update the test ownership map and known gaps. |
| Fix or discover a confusing bug pattern | Add or consolidate durable prevention guidance under recurring development pitfalls and the relevant file subsection; keep active defects under `Known Gaps`. |
| Add a generated file or directory | Document its generator and source of truth; do not treat generated output as the owner. |
| Implement roadmap work | Move it from `Planned` to `Shipped` only after implementation and verification. |
| Discover future work or an optimization | Add it to the authoritative roadmap/backlog/optimization file and link it; do not present it as current behavior. |
| Pure refactor with unchanged boundaries | Update only paths/ownership that changed; do not manufacture a new principle or status item. |
| Local typo or formatting-only edit | No handbook change unless the corrected text changes a command, contract, path, or meaning. |

## Update Protocol: Commit by Commit

When creating or preparing a commit, the agent MUST ensure that the committed `AGENTS.md` describes the repository immediately after that commit—not the state before it and not an aspirational future state.

Before every commit:

1. Review the full diff and list every changed durable fact.
2. Confirm each fact is reflected in the correct handbook section or deliberately absent because it is transient/internal noise.
3. Confirm moved/deleted paths no longer appear as owners.
4. Confirm new behavior is not still labeled planned and incomplete work is not labeled shipped.
5. Run the relevant tests and document checks.
6. Validate local Markdown links and exact commands changed by the commit.
7. Check that README/roadmap/ADR/schema/optimization documents remain consistent.
8. Stage the handbook with the code/docs that made its update necessary.

Commit discipline:

- The handbook update belongs in the same commit as the behavior or ownership change it documents.
- A commit MUST NOT leave `AGENTS.md` knowingly false with a promise to fix it later.
- Do not append a prose summary of each commit to `AGENTS.md`. Git history and changelogs own chronology.
- Squash repeated implementation notes into the final invariant/current-state description before committing.
- Remove superseded workarounds after the underlying defect is fixed.
- If a commit is intentionally partial, label the incomplete surface `Experimental/scaffold` or `Known gap` and state the safe boundary.
- Never rewrite unrelated handbook sections merely to make the documentation diff look substantial.

## Validation Gate

An `AGENTS.md` construction or update is not complete until all applicable checks pass.

### Content checks

- Project identity and non-goals are explicit.
- Principles are concrete and implementation-relevant.
- Critical contracts include dangerous exceptions and negative boundaries.
- Current, experimental, missing, and planned behavior are not mixed.
- Commands come from current manifests/CI/scripts.
- The source map covers all important top-level areas, entry points, registries, boundaries, and hotspots.
- Meaningful files use linked `###` headings rather than file-inventory bullets, and their important symbols/subparts are explained.
- Cross-file features map status, flow, owners, constraints, tests, and gaps.
- Recurring development pitfalls state symptom, cause, prevention, and regression check without becoming a changelog.
- Tests are mapped to the contracts they protect.
- Generated/runtime data is distinguished from source.
- No secrets or personal data appear.

### Link checks

- Extract every local Markdown link target.
- Ignore web URLs and pure anchors.
- Decode the path, strip any fragment, and verify that the target exists.
- Prefer verifying that source references are tracked by version control; explicitly label intentionally untracked runtime/generated paths instead of linking them as source.
- Check that renamed/deleted paths have no stale references.

### Consistency checks

- Compare project name, prerequisites, commands, feature status, configuration keys, and roadmap priorities with the README and other authoritative docs.
- Compare route/command/module maps with the actual registries/manifests.
- Compare persistence claims with schemas, migrations, and adapters.
- Compare critical contracts with focused tests.
- Run the repository's documentation linter/link checker when one exists.

### Diff checks

- Run the version control system's whitespace/diff validation.
- Confirm only intended files changed.
- Confirm the handbook is readable as current reference material without requiring the reader to reconstruct the task that produced it.

## Anti-Patterns to Reject

The agent MUST repair these patterns when found:

- **Thin map:** only a project summary and three generic directories.
- **Flat file inventory:** files appear as one-line bullets, leaving no stable place for symbol descriptions, callers, tests, or file-specific mistakes.
- **Unexplained symbol dump:** function and class names are copied without saying what behavior they locate, what calls them, or why they matter.
- **Changelog blob:** hundreds of chronological “now does X” bullets with no ownership structure.
- **Unlinked inventory:** paths in backticks with no clickable source map.
- **README clone:** public marketing/setup prose copied without agent-specific contracts.
- **Roadmap confusion:** TODOs described as existing features.
- **Source-only truth:** behavior documented without the principle or safety reason that constrains it.
- **Principle-only truth:** philosophy documented without the symbols, files, routes, and tests that implement it.
- **Command folklore:** commands remembered from prior work but absent from manifests or CI.
- **Directory-name descriptions:** “utils contains utilities,” “core contains core logic,” or similar non-information.
- **Manual counters:** hard-coded test/file/user counts that drift after the next edit.
- **Hidden exceptions:** the rule appears in one section and its exception many pages later.
- **Generated ownership:** generated output described as the place to implement behavior instead of its generator/source.
- **Everything is critical:** too many undifferentiated directives, making real invariants forgettable.
- **Bug diary:** dated incidents and superseded workarounds obscure the current reusable rule and whether a defect is still active.

## Recommended Root AGENTS.md Skeleton

Use this as a starting outline after discovery. Replace every placeholder and remove bracketed guidance.

````markdown
# <Project Name> — AI Agent Reference

<One paragraph: purpose, maturity, and what this project is not.>

## Read This First

1. [`README.md`](README.md) — <authority>.
2. [`ROADMAP.md`](ROADMAP.md) — <authority>.
3. [`docs/...`](docs/...) — <authority>.

## Collaboration and Maintenance Rules

- <documentation synchronization rule>
- <test rule>
- <generated/runtime data rule>
- <project-specific commit/release rule>

## Essential Project Principles

### <Principle name>

- <concrete consequence>
- <prohibited implementation>

## Critical Implementation Contracts

- **<Contract>:** <exact rule, exception, enforcing symbol/path, focused test>.

## Architecture and Data/Control Flow

`<entry>` → `<interface>` → `<domain>` → `<persistence/external boundary>`

## Linked Source Tree and File Reference

### [`path/to/file`](path/to/file)

<Responsibility, changes that belong here, and responsibility this file does not own.>

- **Key functions and subparts:**
  - `<symbol>` — <meaning, responsibility, and relevant ordering or side effect>.
  - `<symbol>` — <meaning and relationship to the other subparts>.
- **Called by / depends on:** [`path/to/caller`](path/to/caller); [`path/to/dependency`](path/to/dependency).
- **Tests:** [`path/to/focused_test`](path/to/focused_test).
- **Common mistakes:** <file-specific misunderstanding and safe pattern>.

### [`path/to/another_file`](path/to/another_file)

<Repeat for every meaningful file; do not replace file subsections with a bulleted inventory.>

## Features and Recurring Development Pitfalls

### <Feature name> — <Shipped | Experimental/scaffold | Known gap | Planned>

- **Behavior:** <visible behavior and boundaries>.
- **Flow and owners:** `<entry>` → [`owner`](path/to/owner) (`<key symbol>`) → [`boundary`](path/to/boundary).
- **Constraints:** <configuration, persistence, security, compatibility, or platform rules>.
- **Tests and gaps:** [`focused test`](path/to/test); <remaining gap or `None known`>.

### <Pitfall or bug pattern>

- **Symptom / wrong assumption:** <what an agent observes or may incorrectly infer>.
- **Cause and invariant:** <why it happens and the rule that prevents it>.
- **Risk area:** [`path/to/file`](path/to/file) (`<symbol>`).
- **Safe pattern / regression check:** <implementation guidance>; [`test`](path/to/test) or `<verified command>`.
- **Status:** <active known bug | deliberate limitation | fixed regression risk>.

## Interface Ownership Map

- `<route/command/API/screen/protocol>` → [`owner`](path/to/owner).

## Build, Run, Debug, and Release

```sh
<verified commands>
```

## Test Ownership Map

- <subsystem/contract> → [`focused test`](path/to/test).

## Data, Security, Privacy, and Compatibility Boundaries

- <canonical/derived/local/replicated rule>
- <migration/signing/secret/compatibility rule>

## Current Status and Known Gaps

### Shipped

- <verified behavior>

### Experimental / Scaffold

- <present but incomplete behavior and safe boundary>

### Known Gaps

- <current missing or contradictory behavior>

### Near-Term Priorities

1. <priority linked to authoritative roadmap>

## Task Start and Handoff Checklist

1. <inspect ownership and focused tests>
2. <check principles/contracts/data boundaries>
3. <run checks and synchronize docs>
````

## Completion Definition

The bootstrap task is complete only when the repository's `AGENTS.md`:

- is derived from inspected source and authoritative documents;
- gives an unambiguous hierarchy of principles and current facts;
- contains a precise, clickable ownership map;
- gives each meaningful file a searchable subsection with responsibilities, important code landmarks, dependencies, tests, and common mistakes;
- maps cross-file features and preserves durable prevention guidance for recurring bug patterns;
- exposes dangerous contracts and exceptions near their enforcing code;
- separates shipped, experimental, missing, and planned work;
- provides verified workflows and test ownership;
- defines task-by-task, edit-by-edit, and commit-by-commit maintenance triggers;
- passes link, diff, and consistency validation;
- is concise enough that the truly important rules remain visible.

---

## MiniPhi Addendum: Validation-First Delivery

*This section is not part of the upstream protocol. It is added by MiniPhi
(`docs/guidelines/AGENTS.bootstrap.md`, vendored from
[ai-agents-bootstrap](https://github.com/cekkr/ai-agents-bootstrap)) because a
handbook produced for an autonomous local agent has one requirement the
human-facing protocol leaves implicit: the agent must be able to check its own
work without a human and without eyesight.*

Every `AGENTS.md` produced from this protocol MUST record how the project is
validated automatically, and every task performed under it MUST leave that
validation in place.

### V1. Ship the test with the change

A change is not delivered until something executable proves it. For each unit of
behavior added or repaired, the agent MUST add or extend a **unit test** that
fails before the change and passes after it, and MUST record the exact command
that runs it. "Tested manually", "verified by inspection", and "the server
started" are not validation.

### V2. Automate the interface, not just the function

When the deliverable has a user-facing surface — an HTTP app, a CLI, a GUI, a
rendered page — the agent MUST add an automated end-to-end check of that surface
whenever the tooling allows it: an HTTP scenario test, a CLI invocation test, or
a browser-automation test (Puppeteer/Playwright/Selenium). The check MUST drive
the real surface the user would touch and assert on its real output.

### V3. Assertions must be readable by a model without vision

This is the load-bearing rule. A screenshot is evidence for a vision model and
nothing at all for every other model, and even a vision model cannot diff two
screenshots reliably. Every automated check MUST therefore produce a **textual,
machine-checkable verdict**: an exit code, a named assertion failure, a JSON
report. Where the thing being checked is genuinely visual, assert on the
extractable facts that stand in for it — the rendered DOM contains the expected
elements, the image request returned 200 with a non-zero body, the computed
layout has non-zero width, the page emitted no console error — and treat the
screenshot as an *attachment to* that verdict, never as the verdict.

### V4. Fast, isolated, and runnable from one command

The validation suite MUST run from a single documented command, without manual
setup, network access, or credentials, and MUST be fast enough to run after
every change. If some checks cannot meet that bar (they need hardware, a paid
service, a long soak), they MUST be separated into a clearly named slower target
and the handbook MUST say what they cover and when to run them.

### V5. Record the map, not the intention

The handbook's test ownership map MUST name the file that validates each
contract. A contract with no named test MUST be listed as a known gap rather
than described as covered.
