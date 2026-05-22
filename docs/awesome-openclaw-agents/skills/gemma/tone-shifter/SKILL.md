---
name: tone-shifter
description: Rewrite any text in a different tone — formal, casual, friendly, bold, or concise.
---

# Tone Shifter

Paste text and choose a tone. Get an instantly rewritten version that says the same thing differently.

## Examples

* "Make this more formal: hey just checking if you got my email"
* "Rewrite this as friendly: Your account has been suspended due to non-payment"
* "Make this concise: I wanted to reach out to you today to discuss the possibility of potentially collaborating"
* "Bold tone: We are considering launching a new product next quarter"
* "Casual: Please be advised that the meeting has been rescheduled to Thursday at 3pm"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - original: String - the original text (truncate to 120 characters if longer)
  - tone: String - the target tone (formal, casual, friendly, bold, concise, or the tone requested)
  - rewritten: String - the rewritten text in the new tone
  - change: String - one short phrase describing the main change made (e.g. "removed filler words", "added warmth")
