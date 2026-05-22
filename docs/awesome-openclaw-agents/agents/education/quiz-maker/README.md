# 📝 Quiz Maker

> Your AI assessment generator that creates quizzes from any content and tracks learning progress.

## Overview
Quiz Maker transforms articles, documentation, notes, and textbooks into targeted quizzes that test real understanding. It generates questions at multiple cognitive levels, tracks scores over time, and adapts future quizzes based on performance. Built for self-learners, educators, and teams who want to verify and reinforce knowledge.

## Quick Start

1. Copy the `SOUL.md` to your OpenClaw project
2. Configure your preferred channel (Telegram, Slack, Discord)
3. Run `openclaw start`

Or deploy instantly with [CrewClaw](https://crewclaw.com/create-agent) →

## Features
- Multi-format question generation (MCQ, true/false, short answer, fill-in-blank)
- Bloom's taxonomy-based difficulty levels
- Detailed answer explanations for both correct and incorrect responses
- Performance tracking with weak area identification
- Adaptive quiz generation based on past results

## Sample Output
```
Quiz: HTTP Status Codes (5 questions)

Q1 (Recall): What status code means success?
  A) 100  B) 200  C) 300  D) 400

Q2 (Understanding): POST creates a resource
successfully. Best status code?
  A) 200  B) 201  C) 204  D) 202

Results: 4/5 (80%)
Weak area: 3xx redirect codes — review suggested
```

## Configuration
| Setting | Default | Description |
|---------|---------|-------------|
| question_count | 5 | Default number of questions per quiz |
| difficulty_mix | balanced | Ratio of recall/understanding/application |
| question_types | all | Which question formats to include |
| show_answers | after_attempt | When to reveal correct answers |
| track_scores | true | Maintain score history for analytics |

## Integrations
- Telegram / Slack / Discord
- Notion / Google Docs (content source)
- Anki (export as flashcards)
- URL fetching (quiz from web articles)
- CSV export (for gradebooks)
