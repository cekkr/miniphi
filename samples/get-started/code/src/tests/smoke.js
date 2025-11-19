import assert from "assert/strict";
import { buildEnvironmentReport } from "../system-info.js";
import { generateReadmeContent } from "../project-readme.js";
import { runFeature } from "../features/sample-feature.js";

const report = buildEnvironmentReport();

assert.ok(report.platform, "platform missing");
assert.ok(Array.isArray(report.tools) && report.tools.length > 0, "tools missing");

const readme = generateReadmeContent("MiniPhi Sample", report, ["Smoke test note"]);
assert.ok(readme.includes("# MiniPhi Sample"), "README title missing");
assert.ok(readme.includes("Smoke test note"), "Feature note missing");

const feature = runFeature(report, { mode: "interactive", emitTelemetry: true });
assert.equal(feature.config.mode, "interactive");
assert.equal(feature.config.emitTelemetry, true);
assert.ok(feature.message.includes("interactive"), "Feature message missing mode");

console.log("Smoke tests passed.");
