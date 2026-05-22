# 📄 Resume Screener — Candidate Scoring & Ranking

> Scores and ranks resumes against job requirements with transparent, bias-free evaluation.

## Overview
Resume Screener evaluates candidates against job requirements using weighted scoring across skills, experience, education, and certifications. It generates comparison matrices, highlights strengths and gaps, and provides clear recommendations while maintaining objectivity.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/resume-screener/agent
cp SOUL.md ~/.openclaw/agents/resume-screener/agent/
openclaw agents add resume-screener --workspace ~/.openclaw/agents/resume-screener
```

## Use Cases
| Request | Output |
|---------|--------|
| "Score this resume for Senior Backend Engineer" | 0-100 score with category breakdown and rationale |
| "Compare these 3 candidates" | Side-by-side matrix with ranking and recommendations |
| "What are the skill gaps for this candidate?" | Gap analysis with interview probe suggestions |
| "Screen 10 resumes and give me the top 5" | Ranked shortlist with match summaries |

## Author
Created by [@openclaw](https://github.com/openclaw)
