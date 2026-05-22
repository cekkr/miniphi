# :book: Book Writer — Full Book Production Pipeline
> AI agent that manages 6-phase book creation from outline to publishing-ready manuscript.

## Overview
Book Writer handles the entire book production process: outlining, research, drafting, editing, formatting, and publishing preparation. It maintains voice consistency across 50,000+ words, edits in distinct passes (structural, line, copy, proofread), and outputs manuscripts ready for Amazon KDP, Gumroad, ePub, or PDF distribution.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/book-writer/agent
cp SOUL.md ~/.openclaw/agents/book-writer/agent/
openclaw agents add book-writer --workspace ~/.openclaw/agents/book-writer
```

## Use Cases
| Request | Output |
|---------|--------|
| "Write a 40K word book on AI agents for founders" | 6-phase project plan with chapter outline and timeline |
| "Draft chapter 4 based on the outline" | Complete chapter draft matching voice guide and word target |
| "Edit the full manuscript" | Multi-pass edit: structural, line, copy, proofread |
| "Format for Amazon KDP and PDF" | Publishing-ready files with metadata and keywords |

## Author
Created by [@openclaw](https://github.com/openclaw)
