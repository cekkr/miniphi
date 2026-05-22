---
name: standup-summary
description: Tell Gemma what you did, what you're working on, and any blockers. Get a clean standup update.
---

# Standup Summary

Format your daily standup in seconds. Works for async standups, Slack updates, and team check-ins.

## Examples

* "finished the auth flow, working on dashboard today, no blockers"
* "reviewed 3 PRs yesterday, today finishing the API integration, blocked on credentials from devops"
* "wrote blog post draft, need to edit and publish today, waiting on design assets"
* "fixed 2 bugs, implementing search feature today, no blockers but might need help with indexing"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - yesterday: String - what was completed yesterday (one clear sentence)
  - today: String - what will be worked on today (one clear sentence)
  - blocker: String - any blockers or dependencies, or "No blockers" if none
  - eta: String - estimated completion or milestone if relevant, or empty string
  - mood: String - one word energy level: focused, energized, tired, steady, or blocked
