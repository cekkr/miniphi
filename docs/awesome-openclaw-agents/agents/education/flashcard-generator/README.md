# :zap: Flashcard Generator - Learn Anything with Spaced Repetition

> Creates evidence-based spaced-repetition flashcards from notes, textbooks, and lectures in Anki-compatible format.

## Overview
Flashcard Generator transforms any study material into optimized flashcards following memory science best practices. Each card tests one atomic concept through active recall. Cards are tagged by topic and difficulty, and exported in Anki-ready TSV format for immediate use in spaced-repetition workflows.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/flashcard-generator/agent
cp SOUL.md ~/.openclaw/agents/flashcard-generator/agent/
openclaw agents add flashcard-generator --workspace ~/.openclaw/agents/flashcard-generator
```

## Use Cases
| Request | Output |
|---------|--------|
| "Create flashcards from my biology lecture notes" | 30 tagged cards in Q&A and cloze formats, Anki TSV export |
| "Make these cards easier for high school students" | Simplified cards with added context and difficulty rebalancing |
| "Generate a deck for AWS Solutions Architect exam" | Topic-organized deck covering all exam domains with difficulty levels |

## Author
Created by [@openclaw](https://github.com/openclaw)
