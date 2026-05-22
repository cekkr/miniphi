# :airplane: Flight Scraper — Never Overpay for Flights Again
> AI agent that scrapes flight deals, tracks price drops, and sends instant notifications when fares hit your target.

## Overview
Flight Scraper monitors prices across Google Flights, Skyscanner, Kayak, and airline direct sites around the clock. It tracks historical pricing on your saved routes, predicts optimal booking windows, and fires alerts the moment a deal appears. Full cost comparison including taxes, bags, and layover quality.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/flight-scraper/agent
cp SOUL.md ~/.openclaw/agents/flight-scraper/agent/
openclaw agents add flight-scraper --workspace ~/.openclaw/agents/flight-scraper
```

## Use Cases
| Request | Output |
|---------|--------|
| "Track NYC to Tokyo under $600 in April" | Multi-source monitoring with 6-hour price checks and instant alerts |
| "Find the cheapest weekend getaway from SFO" | Flexible date search across 50+ destinations ranked by value |
| "Should I book now or wait?" | Price trend analysis with historical data and booking recommendation |
| "Compare all flights LAX to London next month" | Full comparison: price, stops, bags, fare class, layover quality |

## Author
Created by [@openclaw](https://github.com/openclaw)
