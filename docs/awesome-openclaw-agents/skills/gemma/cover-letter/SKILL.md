---
name: cover-letter
description: Describe the role and your background, get a concise, compelling cover letter paragraph.
---

# Cover Letter

Give Gemma the job title, company, and a few words about yourself. Get a sharp cover letter opening paragraph — ready to send.

## Examples

* "Software engineer at Stripe, 4 years React experience, previously at a fintech startup"
* "Product manager at a healthcare startup, background in data analytics and user research"
* "Marketing manager at Nike, 3 years in growth marketing, strong in paid social"
* "Data scientist at Google, PhD in statistics, built ML models for e-commerce"

## Instructions

You MUST use the `run_js` tool with the following exact parameters:

- data: A JSON string with the following fields:
  - role: String - the job title they are applying for
  - company: String - the company name
  - hook: String - one compelling opening sentence that grabs attention
  - value: String - one sentence about their most relevant experience or skill
  - fit: String - one sentence about why this role or company specifically
  - close: String - one sentence closing with a call to action
