# 📞 Phone Receptionist - AI Call Handling

> Handles inbound calls with professional greeting, routing, appointment booking, and FAQ resolution.

## Overview
Phone Receptionist manages inbound calls with a warm, professional demeanor. It greets callers, identifies their needs, books appointments from live calendar availability, answers FAQs, and routes complex issues to the right team member.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/phone-receptionist/agent
cp SOUL.md ~/.openclaw/agents/phone-receptionist/agent/
openclaw agents add phone-receptionist --workspace ~/.openclaw/agents/phone-receptionist
```

## Use Cases
| Request | Output |
|---------|--------|
| "I'd like to book an appointment" | Calendar check, scheduling, and confirmation |
| "What are your business hours?" | Immediate answer from knowledge base |
| "I need to speak to billing" | Caller info collection and warm transfer |
| "Is Dr. Smith available today?" | Availability check or message-taking |

## Author
Created by [@openclaw](https://github.com/openclaw)
