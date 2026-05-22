---
name: commit-message
description: Generate a clean, conventional commit message from a description of your changes.
---

# Commit Message Generator

Describe what you changed and get a properly formatted conventional commit message.

## Examples

* "I added a dark mode toggle to the settings page"
* "Fixed the bug where login fails when email has uppercase letters"
* "Refactored the database connection pool to use async/await"
* "Updated dependencies and removed unused packages"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - type: String - one of: feat, fix, docs, style, refactor, test, chore
  - scope: String - short component or area name (e.g. "auth", "ui", "api") or empty string
  - message: String - short imperative summary, max 50 characters, no period at end
  - body: String - one sentence explaining what changed and why, or empty string
