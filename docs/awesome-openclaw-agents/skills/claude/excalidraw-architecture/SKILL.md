---
name: excalidraw-architecture
description: Trigger when the user asks for an architecture diagram, says "draw the system", "update the architecture diagram", "give me an excalidraw of this codebase", or "/excalidraw-architecture". Generates or updates an Excalidraw JSON file at docs/architecture.excalidraw by reading the codebase's key entry points.
---

# Excalidraw Architecture

Produce an architecture diagram of the current project as an Excalidraw file (`docs/architecture.excalidraw`). The diagram shows services, entry points, data stores, and the edges between them — the kind of whiteboard sketch you'd draw in a design review.

Inspired by Bilgin Ibryam's Medium post on "Architecture diagrams as code with Claude Code + Excalidraw" — credit: [@bibryam](https://medium.com/@bibryam). This skill is a lightweight reimplementation for OpenClaw-style repos.

## When to use

- New contributor asks "what does this repo look like?"
- User wants to update a stale architecture diagram after a refactor
- User says "draw me the system", "excalidraw the backend", "/excalidraw-architecture"
- Preparing a design doc and needs a canonical diagram

## Instructions

1. **Survey the codebase.** Use Glob and Grep to identify:
   - Entry points: `main.*`, `index.*`, `server.*`, `api/**/route.*`, `cmd/*/main.go`, `package.json` "scripts" field, `Dockerfile` `CMD`.
   - Data stores: mentions of `postgres`, `redis`, `convex`, `sqlite`, `s3`, `mongodb`, `prisma`.
   - External services: Stripe, OpenAI, Anthropic, Twilio, SendGrid, webhook handlers.
   - Internal modules: top-level folders under `src/`, `app/`, `lib/`, `agents/`.
   Read at most 3-5 key files to confirm how the pieces connect — don't try to read the whole repo.
2. **Sketch the model mentally.** List nodes (rectangles) and edges (arrows with labels like "HTTP", "SQL", "pub/sub"). Group related nodes into clusters.
3. **Generate the Excalidraw JSON.** The file format is standard Excalidraw:
   ```json
   {
     "type": "excalidraw",
     "version": 2,
     "source": "https://excalidraw.com",
     "elements": [ /* rectangle, arrow, text elements */ ],
     "appState": { "viewBackgroundColor": "#ffffff", "gridSize": 20 },
     "files": {}
   }
   ```
   Each element needs at minimum: `id`, `type` (`rectangle` / `arrow` / `text` / `ellipse`), `x`, `y`, `width`, `height`, `angle: 0`, `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `roughness`, `opacity`, `seed`, `versionNonce`, `isDeleted: false`, `groupIds: []`, `boundElements`, `updated`, `link: null`, `locked: false`. For text elements add `text`, `fontSize`, `fontFamily`, `textAlign`, `verticalAlign`. For arrows add `points`, `startBinding`, `endBinding`. Use integer pixel coordinates on a ~20px grid. Arrange nodes left-to-right by data flow.
4. **Do not hand-forge exotic fields you're unsure about.** If a field is optional and you're not confident, omit it — Excalidraw is forgiving on load. When in doubt, open the resulting file in the Excalidraw web app and confirm it renders; fix any errors it reports.
5. **Write the file** to `docs/architecture.excalidraw` using the Write tool. If the directory doesn't exist, create it first with `mkdir -p docs`.
6. **Offer to open it.** Suggest the user run:
   ```bash
   open docs/architecture.excalidraw   # macOS — opens in Excalidraw desktop app if installed
   ```
   Or drag-drop into [excalidraw.com](https://excalidraw.com).
7. **Update vs regenerate.** If `docs/architecture.excalidraw` already exists, read it first. If the existing layout still fits, only add/move the nodes that changed. If the shape of the system has changed significantly, tell the user and regenerate from scratch.

## Style guidelines

- Rectangles for services, ellipses for datastores, small rectangles with dashed stroke for external SaaS.
- Arrows labelled with the protocol (`HTTP`, `gRPC`, `SQL`, `webhook`).
- Max ~15 nodes. If the system is bigger, produce a top-level diagram and suggest follow-up per-subsystem diagrams.
- Leave a title text element at the top: `<repo name> — architecture (generated <date>)`.

## Example invocations

- `/excalidraw-architecture`
- "Draw the architecture of this repo"
- "Update docs/architecture.excalidraw — I just added a Redis queue"
- "Give me an excalidraw diagram of how the OpenClaw gateway talks to agents"
