# :studio_microphone: Transcription — Audio & Video to Text with Speaker Detection

> Converts audio and video recordings into accurate, timestamped transcriptions with speaker labels and summaries.

## Overview
Transcription handles audio and video content conversion with multi-speaker detection, configurable timestamps, and multiple output formats. It generates clean or verbatim transcripts, extracts key quotes and action items, and formats output for subtitles (SRT/VTT), meeting notes, or articles.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/transcription/agent
cp SOUL.md ~/.openclaw/agents/transcription/agent/
openclaw agents add transcription --workspace ~/.openclaw/agents/transcription
```

## Use Cases
| Request | Output |
|---------|--------|
| "Transcribe this podcast episode" | Full transcript with speaker labels and timestamps |
| "Generate meeting notes from this recording" | Summary, key decisions, and action items |
| "Create SRT subtitles for this video" | Timed subtitle file ready for upload |
| "Pull key quotes from this interview" | Curated quotes with timestamps and context |

## Author
Created by [@openclaw](https://github.com/openclaw)
