---
title: MiniPhi runtime hosts and model behaviour
tags: lmstudio, cheetah, models, runtime
kind: reference
importance: 0.9
---

# MiniPhi runtime hosts and model behaviour

Facts established by real runs against the reference hosts. Each `##` section is separately
recallable, so keep one subject per section.

## LM Studio reference host

The LAN LM Studio host is `http://192.168.1.5:1234`. It serves the native `/api/v1/models`
inventory and the OpenAI-compatible `/v1/chat/completions` route. `LMSTUDIO_REST_URL` overrides the
configured endpoint and is what live runs should set rather than editing a checked-in loopback URL.

## Reasoning must be sent as reasoning_effort

The compatible `/chat/completions` route honours `reasoning_effort` and silently ignores
`reasoning`, which is the native v1 spelling. That route validates `reasoning_effort` against
`none`, `minimal`, `low`, `medium`, `high` and `xhigh`, and returns HTTP 400 for anything else —
including the literal value `off`, which is MiniPhi's own spelling for "no reasoning" and must be
mapped to `none`.

## prism-ml/bonsai-27b throughput

The model `prism-ml/bonsai-27b` is a 27B Q1_0 GGUF that advertises vision and tool use with a
262144 maximum context. Measured on the reference host at a loaded 32768 context, it processes
prompts at roughly 120 tokens per second and generates at roughly 7 tokens per second, so prompt
size dominates turn latency and a context budget around 6500 tokens keeps a turn near a minute of
prefill. Its vision capability is real: it described an unlabelled placeholder image correctly and
produced an accurate, specific critique of a rendered page.

## A reasoning model returns empty content when its budget is too small

When a reasoning model is given a small `max_tokens`, it spends the whole budget on its reasoning
trace and returns `finish_reason` of `length` with empty content and zero usable JSON. This is a
budget failure, not a schema failure, and retrying at the same cap can only fail again. The 512
token defaults that MiniPhi's vision reviewer and reference composer once used were sized for
non-reasoning models and were raised to 3072.

## Load a large model with parallel 1 and flash attention

The LM Studio load endpoint takes its configuration as flat top-level fields next to `model`, not
inside a nested `config` object, and it names the model field `model` rather than `model_key`.
Loading `prism-ml/bonsai-27b` with the defaults gave a 32768 context with `parallel` set to 4 and
flash attention disabled, which reserves roughly four times the key-value cache the agent actually
needs and made the inference engine die partway through long generations, answering HTTP 400 with
`Engine protocol predict request failed` and then hanging on every later request until the model was
unloaded and loaded again. Reloading the same model with a 16384 context, `parallel` set to 1 and
flash attention enabled removed the crash entirely and roughly doubled prompt processing to about
220 tokens per second, while generation stayed near 7.7 tokens per second.

## Bound the tokens a single agent turn may generate

Leaving the per-turn token limit unbounded lets one turn generate the entire remaining context
window, which on a model producing about 7 tokens per second is an hour inside a single HTTP
request, and a request that long is where both the client transport and the inference engine give
out. Capping a turn at roughly four thousand tokens keeps every request within minutes and pushes
the model toward writing one file per turn.

## Cheetah server

Build the Cheetah server with `bash build.sh` inside `thirds/cheetah` and run it with
`CHEETAH_HEADLESS=1 ./cheetah-server`, which listens on port 4455 and disables the interactive CLI.
Its data directory `cheetah_data/` lives beside the binary and does not travel with the project,
which is why durable project memory belongs in `.miniphi/memory/` instead.
