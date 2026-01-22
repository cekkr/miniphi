# Multi‑LLM RL Router (toy programming agent)

This example project demonstrates the core idea from the uploaded paper: **use local reinforcement learning to orchestrate multiple LLMs** in a multi‑step programming agent workflow.

What you get:

- ✅ **RL router (tabular Q‑learning)** to pick which LLM to query each step (cheap/fast vs strong/slow).
- ✅ **JSON-only structured outputs** (tool calls) from the LLM.
- ✅ **Tool loop** with a local workspace: write files + run tests + feed observations back.
- ✅ A **fast simulation environment** to train the router before plugging in real models.
- ✅ Plug‑in wrappers for **Ollama** (local LLM server) or a **MockLLM** (no models required).

> This is a minimal demo: the point is to show the architecture end-to-end with accessible libraries.

---

## 1) Setup (Python)

```bash
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows
# .venv\Scripts\activate

pip install -r requirements.txt
```

---

## 2) Train the router quickly (simulation)

This trains the model-selection policy in a tiny stochastic environment.

```bash
python -m src.train_router --episodes 5000 --save router_q.json
```

You should see the greedy choices converge to something like:

- easy → `fast`
- medium → `balanced` or `strong`
- hard → `strong`

---

## 3) Run the programming agent (no real LLMs)

The agent uses `MockLLM` backends but still:

- emits JSON tool calls
- writes `solution.py`
- runs `unittest`
- uses test output as feedback / reward
- updates the router if `--learn` is enabled

```bash
python -m src.run_agent --backend mock --learn
```

---

## 4) Swap in real local LLMs (Ollama)

If you already use Ollama:

1. Install Ollama
2. Pull a few models
3. Make sure the server is running
4. Run:

```bash
python -m src.run_agent --backend ollama --learn
```

Edit `src/run_agent.py` to match model names you have pulled (the defaults are placeholders).

---

## 5) Where to look in the code

- `src/q_router.py` — tabular Q‑learning router (ε‑greedy).
- `src/env_sim.py` — fast simulation environment for router training.
- `src/agent.py` — the agent loop (query → tool → observe → reward → update).
- `src/llms.py` — `MockLLM` + `OllamaLLM` wrappers.
- `src/tools.py` — safe-ish file + test tools.
- `tasks/*` — small coding tasks (spec + tests).

---

## Security note

`run_command` is intentionally restricted (only `python ...`) in this demo. For a real agent, use a sandbox/container.

---

## NodeJS (optional)

See `node/` for a minimal Ollama client and the same Q-learning router in JS.

