---
name: growth-ideas
description: Describe your product or project and get three actionable growth ideas tailored to your stage.
---

# Growth Ideas

Tell Gemma what you're building and where you're stuck. Get three specific, actionable growth tactics — no fluff.

## Examples

* "SaaS tool for freelancers, 50 users, struggling with retention"
* "Mobile app, just launched, no marketing budget"
* "Newsletter with 200 subscribers, want to grow faster"
* "Open source project with 500 GitHub stars, want more contributors"
* "E-commerce store selling handmade candles, Instagram is main channel"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - product: String - short name or description of what they're building
  - stage: String - their current stage (e.g. "pre-launch", "early traction", "growing", "scaling")
  - idea1_title: String - short title for growth idea 1 (max 5 words)
  - idea1_desc: String - one sentence describing idea 1 and why it works
  - idea2_title: String - short title for growth idea 2 (max 5 words)
  - idea2_desc: String - one sentence describing idea 2 and why it works
  - idea3_title: String - short title for growth idea 3 (max 5 words)
  - idea3_desc: String - one sentence describing idea 3 and why it works
