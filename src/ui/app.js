import { useApp, useInput } from "ink";
import { html, Box, Text, useState, useEffect, useRef, useMemo } from "./ink-elements.js";
import { BRAND } from "./theme.js";
import FilePicker from "./components/file-picker.js";
import ModelPicker from "./components/model-picker.js";
import PromptInput from "./components/prompt-input.js";
import ProgressPane from "./components/progress-pane.js";
import PermissionModal from "./components/permission-modal.js";
import BenchmarkDashboard from "./components/benchmark-dashboard.js";
import { buildUiModelSelection } from "./model-selection.js";

function describePayloadAction(action) {
  if (!action || typeof action !== "object") return "action";
  const target = action.path ?? action.term ?? action.command ?? "";
  return `${action.type ?? "?"}${target ? ` ${target}` : ""}`.trim();
}

/**
 * Root MiniPhi UI. Phases: home/easy benchmark table → pick files → enter task
 * → choose benchmark-informed Auto/manual model → run (with inline permission
 * modals) → done. Subscribes to the injected AgentSession's events and
 * reflects them as a live progress log.
 */
export default function App({
  session,
  files = [],
  initialTask = "",
  startPhase = "prompt",
  modelCatalog = [],
  modelCatalogSource = null,
  requestedModel = "auto",
  benchmarkIndex = null,
  runEasyBenchmark = null,
}) {
  const { exit } = useApp();
  const [phase, setPhase] = useState(initialTask ? "prompt" : startPhase);
  const [task, setTask] = useState(initialTask);
  const [pinned, setPinned] = useState([]);
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(null);
  const [result, setResult] = useState(null);
  const [benchmarks, setBenchmarks] = useState(benchmarkIndex);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [benchmarkStatus, setBenchmarkStatus] = useState("");
  const startedRef = useRef(false);
  const modelSelection = useMemo(
    () =>
      buildUiModelSelection({
        models: modelCatalog,
        task,
        requestedModel,
        source: modelCatalogSource,
        benchmarkResults: benchmarks?.results ?? null,
      }),
    [benchmarks, modelCatalog, modelCatalogSource, requestedModel, task],
  );

  const appendLog = (entry) => setLog((prev) => [...prev, entry]);

  // Spinner animation while running.
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(timer);
  }, [running]);

  // Start the agent once we enter the running phase.
  useEffect(() => {
    if (phase !== "running" || startedRef.current) return undefined;
    startedRef.current = true;

    const onStatus = ({ summary, summaryUpdates }) => {
      if (summary) appendLog({ kind: "status", text: summary });
      (summaryUpdates || []).forEach((u) => appendLog({ kind: "status", text: u }));
    };
    const onActionResult = (payload) => {
      appendLog({ kind: "action", text: describePayloadAction(payload.action), status: payload.status });
    };
    const onEditProposed = ({ proposal }) => {
      appendLog({ kind: "status", text: `proposing ${proposal.type} ${proposal.path}` });
    };
    const onPermission = ({ id, request }) => setPending({ id, request });
    const onDone = (payload) => {
      setResult(payload);
      setRunning(false);
      setPhase("done");
    };
    const onError = (payload) => appendLog({ kind: "action", text: payload.message ?? "error", status: "failed" });

    session.on("status", onStatus);
    session.on("action-result", onActionResult);
    session.on("edit-proposed", onEditProposed);
    session.on("permission-request", onPermission);
    session.on("done", onDone);
    session.on("error", onError);

    setRunning(true);
    Promise.resolve(session.submitTask(task, pinned)).catch((err) => {
      appendLog({ kind: "action", text: err instanceof Error ? err.message : String(err), status: "failed" });
      setRunning(false);
      setPhase("done");
    });

    return () => {
      session.off("status", onStatus);
      session.off("action-result", onActionResult);
      session.off("edit-proposed", onEditProposed);
      session.off("permission-request", onPermission);
      session.off("done", onDone);
      session.off("error", onError);
    };
  }, [phase, session, task, pinned]);

  const header = html`
    <${Box} marginBottom=${1}>
      <${Text} color="magenta" bold>${BRAND} </${Text}>
      <${Text} dimColor>local coding agent</${Text}>
    </${Box}>
  `;

  if (phase === "home") {
    return html`<${Box} flexDirection="column">${header}
      <${BenchmarkDashboard}
        benchmarkIndex=${benchmarks}
        running=${benchmarkRunning}
        status=${benchmarkStatus}
        onStart=${() => setPhase(files.length ? "picker" : "prompt")}
        onRunEasy=${async () => {
          if (!runEasyBenchmark || benchmarkRunning) return;
          setBenchmarkRunning(true);
          setBenchmarkStatus("Scanning LM Studio models…");
          try {
            const benchmarkResult = await runEasyBenchmark((event) => {
              if (event.type === "model-start") {
                setBenchmarkStatus(`Testing ${event.modelId}…`);
              } else if (event.type === "cache-hit") {
                setBenchmarkStatus(`Using cached score for ${event.modelId}…`);
              } else if (event.type === "trial-start") {
                setBenchmarkStatus(`${event.modelId}: ${event.trialId}`);
              }
            });
            setBenchmarks(benchmarkResult.index);
            const completed = benchmarkResult.results.filter(
              (entry) => entry.status === "completed",
            ).length;
            setBenchmarkStatus(
              `Benchmarks ready: ${completed}/${benchmarkResult.modelCount} model(s). Auto now uses these scores.`,
            );
          } catch (error) {
            setBenchmarkStatus(
              `Failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            setBenchmarkRunning(false);
          }
        }}
        onQuit=${exit}
      />
    </${Box}>`;
  }

  if (phase === "picker") {
    return html`<${Box} flexDirection="column">${header}
      <${FilePicker}
        files=${files}
        onSubmit=${(sel) => {
          setPinned(sel);
          setPhase("prompt");
        }}
        onSkip=${() => setPhase("prompt")}
      />
    </${Box}>`;
  }

  if (phase === "prompt") {
    return html`<${Box} flexDirection="column">${header}
      <${PromptInput}
        value=${task}
        onChange=${setTask}
        pinnedCount=${pinned.length}
        onSubmit=${(value) => {
          const trimmed = (value || "").trim();
          if (!trimmed) return;
          setTask(trimmed);
          setPhase(modelSelection.choices.length ? "model" : "running");
        }}
      />
    </${Box}>`;
  }

  if (phase === "model") {
    return html`<${Box} flexDirection="column">${header}
      <${ModelPicker}
        choices=${modelSelection.choices}
        selectedValue=${modelSelection.selectedValue}
        intent=${modelSelection.intent}
        onSubmit=${(choice) => {
          const model = choice.model ?? {};
          session.configureModel({
            model: choice.resolvedModel,
            contextLength: model.loadedContextLength,
            selection: {
              requested: choice.requested,
              source: choice.source,
              intent: choice.intent,
              score: Number.isFinite(choice.score) ? choice.score : null,
              reasons: choice.reasons ?? [],
              benchmark: choice.benchmark ?? null,
              state: model.state ?? "unknown",
              loadedInstanceId: model.loadedInstanceId ?? null,
              loadedContextLength: model.loadedContextLength ?? null,
              maxContextLength: model.maxContextLength ?? null,
              capabilities: model.capabilities ?? [],
              loadConfig: model.loadedInstances?.[0]?.config ?? null,
            },
          });
          setPhase("running");
        }}
        onSkip=${() => setPhase("running")}
      />
    </${Box}>`;
  }

  if (phase === "running") {
    return html`<${Box} flexDirection="column">${header}
      <${ProgressPane} task=${task} log=${log} running=${running} tick=${tick} />
      ${pending
        ? html`<${Box} marginTop=${1}>
            <${PermissionModal}
              request=${pending.request}
              onDecision=${(decision) => {
                session.resolvePermission(pending.id, decision);
                setPending(null);
              }}
            />
          </${Box}>`
        : null}
    </${Box}>`;
  }

  // done
  const editCount = result?.edits?.length ?? 0;
  const applied = (result?.edits ?? []).filter((e) => e.status === "written" || e.status === "unchanged");
  return html`<${Box} flexDirection="column">${header}
    <${ProgressPane} task=${task} log=${log} running=${false} summary=${result?.summary ?? ""} />
    <${Box} flexDirection="column" marginTop=${1}>
      <${Text} color=${result?.status === "completed" ? "green" : "yellow"}>
        ${result?.status === "completed" ? "✔ completed" : `stopped (${result?.stopReason ?? "unknown"})`} · ${editCount} edit(s)
      </${Text}>
      ${applied.map((e, i) => html`<${Text} key=${i} color="green">  ✎ ${e.action?.path ?? ""} (${e.status})</${Text}>`)}
      <${Box} marginTop=${1}><${Text} dimColor>Press q or Ctrl+C to exit.</${Text}></${Box}>
    </${Box}>
    <${QuitOnKey} onQuit=${exit} />
  </${Box}>`;
}

// Small helper so the done screen can be dismissed with `q`.
function QuitOnKey({ onQuit }) {
  useInput((input) => {
    if ((input || "").toLowerCase() === "q") onQuit();
  });
  return null;
}
