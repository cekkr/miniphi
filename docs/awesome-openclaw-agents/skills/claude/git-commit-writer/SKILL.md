---
name: git-commit-writer
description: Trigger when the user asks to write a commit message, generate a commit from staged changes, review a diff before committing, or says "/commit". Reads git diff --staged and produces an opinionated, convention-matching commit message.
---

# Git Commit Writer

Generate a disciplined commit message from the currently staged changes. Opinionated about style: imperative mood, concise title, body that explains **why** not **what**.

## When to use

- User says "write a commit message", "/commit", "commit this"
- User has staged changes and asks to review them before committing
- User asks "what should this commit be called"

Do NOT use this skill to actually run `git commit` unless the user explicitly asks — just draft the message and show it.

## Instructions

1. Run `git status --short` with the Bash tool. Confirm there are staged changes. If nothing is staged, stop and tell the user.
2. Run `git diff --staged` to read the full staged diff. If the diff is large (>500 lines), also run `git diff --staged --stat` to get a file-level overview first.
3. Run `git log --oneline -10` to learn the repo's commit convention. Look for:
   - Conventional Commits prefixes (`feat:`, `fix:`, `chore:`) — if present, match the style.
   - Title case vs sentence case.
   - Whether bodies are used or not.
   - Any ticket / issue prefix (e.g. `[PROJ-123]`).
4. Draft a message following these rules:
   - **Title:** imperative mood ("Add X", not "Added X" or "Adds X"), max 70 characters, no trailing period.
   - **Body (if needed):** blank line after title, then 1-3 short paragraphs or bullets explaining *why* the change is necessary, what problem it solves, what trade-offs were made.
   - **Never** use the word "refactor" alone — always say what was refactored and why ("Extract retry loop into helper to share with job runner").
   - **Never** write "Update file.js" — describe the behavior change, not the file touched.
   - **Never** invent a ticket number. If the repo uses them but you can't infer one, leave it out.
5. Show the drafted message in a fenced code block. Ask the user if they want you to run `git commit` with it. Do not commit automatically.

## Anti-patterns to reject

- "Various fixes" / "Updates" / "WIP" — reject and ask for specifics from the diff.
- "Refactor code" — must name the unit being refactored.
- Title >70 chars — shorten or move detail to body.
- Past tense or "-ing" forms — rewrite to imperative.

## Example invocations

- `/git-commit-writer`
- "Write a commit message for what I have staged"
- "Review my staged diff and draft a commit"
- "/commit — but don't push"
