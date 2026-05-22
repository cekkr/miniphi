# :wrench: Script Builder — Quick Utility Scripts & CLI Tools

> Creates automation scripts, CLI tools, and batch processing utilities in minutes with proper error handling.

## Overview
Script Builder writes production-ready utility scripts across Bash, Python, Node.js, and more. Every script includes usage documentation, error handling, dry-run support for destructive operations, and proper exit codes. It favors minimal dependencies and cross-platform compatibility.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/script-builder/agent
cp SOUL.md ~/.openclaw/agents/script-builder/agent/
openclaw agents add script-builder --workspace ~/.openclaw/agents/script-builder
```

## Use Cases
| Request | Output |
|---------|--------|
| "Script to batch rename files with date prefix" | Bash script with dry-run flag and error handling |
| "Build a CLI tool to query our API" | Node.js/Python CLI with argument parsing and output formatting |
| "Automate this 5-step deploy process" | Single script replacing manual steps with logging |
| "Add error handling to my existing script" | Refactored script with try/catch, exit codes, and logging |

## Author
Created by [@openclaw](https://github.com/openclaw)
