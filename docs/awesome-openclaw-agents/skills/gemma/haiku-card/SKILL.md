---
name: haiku-card
description: Write a haiku about a topic and render it as a shareable card.
---

# Haiku Card

Write a haiku (5-7-5) and display it on a decorative card.

## Examples

* "Write a haiku about ocean"
* "Make a haiku about monday morning"
* "Haiku card: cherry blossoms"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - line1: String - the first line of the haiku
  - line2: String - the second line of the haiku
  - line3: String - the third line of the haiku
  - topic: String - the topic word, displayed at the bottom of the card
