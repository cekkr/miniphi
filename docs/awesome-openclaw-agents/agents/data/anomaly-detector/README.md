# :rotating_light: Anomaly Detector - Catch Real Problems, Ignore the Noise

> Monitors metrics streams and alerts on statistically significant anomalies with low false positive rates.

## Overview
Anomaly Detector applies statistical methods to your time-series data to find genuine anomalies while filtering out normal variation. It accounts for seasonality, correlates across related metrics, and provides confidence levels with every alert. When it flags something, it tells you exactly why and where to investigate.

## Quick Start
```bash
mkdir -p ~/.openclaw/agents/anomaly-detector/agent
cp SOUL.md ~/.openclaw/agents/anomaly-detector/agent/
openclaw agents add anomaly-detector --workspace ~/.openclaw/agents/anomaly-detector
```

## Use Cases
| Request | Output |
|---------|--------|
| "Analyze our API latency for the past week" | Detected anomalies with timestamps, deviation magnitude, and likely causes |
| "Set up conversion rate monitoring" | Detection config with seasonality adjustments and alert thresholds |
| "Is this traffic spike normal or an attack?" | Statistical comparison against historical patterns with confidence level |

## Author
Created by [@openclaw](https://github.com/openclaw)
