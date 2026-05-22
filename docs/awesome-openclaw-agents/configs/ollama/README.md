# Ollama-Optimized Agent Configs

Ready-to-use OpenClaw agent configurations optimized for local Ollama models. These SOUL.md files use shorter prompts and focused instructions designed for smaller context windows.

## Available Agents

| Agent | Model | Use Case |
|-------|-------|----------|
| coding-assistant | gemma4 | Code generation, debugging, refactoring |
| content-writer | qwen3 | Blog posts, social media, marketing copy |
| research-analyst | deepseek-v3 | Topic research, comparisons, analysis |
| project-manager | gemma4:26b | Task planning, PRDs, status updates |
| customer-support | gemma4:e4b | Issue resolution, FAQ, escalation |

## Quick Start

1. Pull the model you need:

```bash
ollama pull gemma4
```

2. Copy the SOUL.md to your OpenClaw agent directory:

```bash
cp configs/ollama/coding-assistant/SOUL.md ~/.openclaw/agents/coding-assistant/SOUL.md
```

3. Launch the agent:

```bash
ollama launch openclaw --model gemma4
```

Or run directly with OpenClaw CLI:

```bash
openclaw agent --agent coding-assistant --message "Write a Python function to merge two sorted lists"
```

## Model Recommendations by Hardware

| Hardware | RAM | Recommended Model | Agent |
|----------|-----|-------------------|-------|
| Apple M1/M2 (8GB) | 8 GB | gemma4:e4b | customer-support |
| Apple M1/M2 (16GB) | 16 GB | gemma4 | coding-assistant |
| Apple M3/M4 (16GB+) | 16-32 GB | gemma4:26b | project-manager |
| Desktop GPU (12GB+ VRAM) | 32 GB | deepseek-v3 | research-analyst |
| Any (16GB+) | 16 GB+ | qwen3 | content-writer |

## Design Principles

- **Token-efficient**: Short system prompts that fit in smaller context windows
- **Focused rules**: Each agent has 5 rules max to avoid instruction drift
- **Local-first**: No API keys or external dependencies required
- **Portable**: Just a SOUL.md file — copy it anywhere OpenClaw runs
