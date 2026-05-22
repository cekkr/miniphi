# :newspaper: News Curator — 50+ Sources, Zero Noise
> AI agent that scans dozens of sources, curates with AI scoring, and manages a full publishing pipeline.

## Overview
News Curator monitors 50+ sources including RSS feeds, Hacker News, Reddit, Twitter/X, and niche publications. It scores every story for relevance, writes concise summaries with original analysis, and manages a publishing pipeline from draft to scheduled delivery. Engagement metrics feed back into curation quality over time.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/news-curator/agent
cp SOUL.md ~/.openclaw/agents/news-curator/agent/
openclaw agents add news-curator --workspace ~/.openclaw/agents/news-curator
```

## Use Cases
| Request | Output |
|---------|--------|
| "Set up a daily AI news digest for developers" | 52 sources configured with relevance filters and daily publishing |
| "What broke in AI news today?" | Ranked stories with summaries, scores, and context |
| "Turn today's top 3 stories into tweets" | Platform-adapted posts with hooks and source links |
| "What trends are emerging this week?" | Cross-story analysis connecting dots across multiple sources |

## Author
Created by [@openclaw](https://github.com/openclaw)
