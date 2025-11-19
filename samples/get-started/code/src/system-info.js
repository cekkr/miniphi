import os from "os";
import { execSync } from "child_process";

const DEFAULT_TOOLS = ["node", "npm", "git", "python3"];

function detectToolVersion(command) {
  try {
    const output = execSync(`${command} --version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
    }).trim();
    return output.split(/\s+/).slice(-1)[0] ?? output;
  } catch {
    return null;
  }
}

export function discoverTools(toolList = DEFAULT_TOOLS) {
  return toolList.map((tool) => {
    const version = detectToolVersion(tool);
    return {
      name: tool,
      available: Boolean(version),
      version,
    };
  });
}

export function buildEnvironmentReport(toolList = DEFAULT_TOOLS) {
  const hostname = os.hostname();
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const nodeVersion = process.version.replace(/^v/, "");
  const cpuCount = os.cpus()?.length ?? 0;
  const memoryGB = Number((os.totalmem() / (1024 ** 3)).toFixed(2));

  return {
    host: hostname,
    platform,
    release,
    arch,
    nodeVersion,
    cpuCount,
    memoryGB,
    tools: discoverTools(toolList),
  };
}

export function formatEnvironmentReport(report) {
  const lines = [
    `Host: ${report.host}`,
    `Platform: ${report.platform} ${report.release} (${report.arch})`,
    `Node.js: ${report.nodeVersion}`,
    `CPUs: ${report.cpuCount}`,
    `Memory: ${report.memoryGB} GB`,
    "",
    "Tools:",
  ];
  for (const tool of report.tools) {
    const status = tool.available ? `available (${tool.version})` : "missing";
    lines.push(`- ${tool.name}: ${status}`);
  }
  return lines.join("\n");
}

export function summarizeMissingTools(report) {
  const missing = report.tools.filter((tool) => !tool.available).map((tool) => tool.name);
  if (missing.length === 0) {
    return "All essential tools are available.";
  }
  return `Missing tools: ${missing.join(", ")}.`;
}
