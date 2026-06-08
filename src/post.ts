import * as core from "@actions/core";
import * as fs from "fs";

interface Sample {
  ts: number;
  cpu: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_read_mbs: number;
  disk_write_mbs: number;
  net_in_mbs: number;
  net_out_mbs: number;
}

async function run(): Promise<void> {
  try {
    const metricsFile = "/tmp/ir-metrics.jsonl";
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;

    if (!summaryFile) {
      core.debug("GITHUB_STEP_SUMMARY not set");
      return;
    }

    if (!fs.existsSync(metricsFile)) {
      core.info("No metrics file found — skipping summary");
      return;
    }

    const lines = fs.readFileSync(metricsFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length < 3) {
      core.info("Not enough samples for meaningful metrics");
      return;
    }

    const samples: Sample[] = lines.map((l) => JSON.parse(l));
    const showDisk = core.getInput("show-disk") !== "false";
    const showNetwork = core.getInput("show-network") !== "false";

    const summary = renderSummary(samples, showDisk, showNetwork);
    fs.appendFileSync(summaryFile, summary);

    // Set outputs
    const duration = samples[samples.length - 1].ts - samples[0].ts;
    const cpuValues = samples.map((s) => s.cpu);
    const memValues = samples.map((s) => s.mem_used_mb);

    core.setOutput("duration", String(duration));
    core.setOutput("cpu-avg", String(Math.round(avg(cpuValues))));
    core.setOutput("cpu-peak", String(Math.round(Math.max(...cpuValues))));
    core.setOutput("mem-avg-mb", String(Math.round(avg(memValues))));
    core.setOutput("mem-peak-mb", String(Math.round(Math.max(...memValues))));

    core.info(`Build metrics rendered (${samples.length} samples, ${duration}s)`);
  } catch (error) {
    // Never fail the job for observability
    core.debug(`Observe post error: ${error}`);
  }
}

function renderSummary(samples: Sample[], showDisk: boolean, showNetwork: boolean): string {
  const duration = samples[samples.length - 1].ts - samples[0].ts;
  const memTotal = samples[0].mem_total_mb;

  const cpuValues = samples.map((s) => s.cpu);
  const memValues = samples.map((s) => s.mem_used_mb);
  const diskRValues = samples.map((s) => s.disk_read_mbs);
  const diskWValues = samples.map((s) => s.disk_write_mbs);
  const netInValues = samples.map((s) => s.net_in_mbs);
  const netOutValues = samples.map((s) => s.net_out_mbs);

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("### ⚡ IRunner Build Metrics");
  lines.push("");
  lines.push(`> **Duration:** ${formatDuration(duration)} &nbsp;|&nbsp; **Samples:** ${samples.length}`);
  lines.push("");

  // CPU
  lines.push(`<details open><summary><b>CPU</b> — avg ${avg(cpuValues).toFixed(0)}% &nbsp; peak ${Math.max(...cpuValues).toFixed(0)}%</summary>`);
  lines.push("");
  lines.push("```");
  lines.push(renderBarChart(cpuValues, 0, 100, 60));
  lines.push("```");
  lines.push("</details>");
  lines.push("");

  // Memory
  lines.push(`<details open><summary><b>Memory</b> — avg ${formatMB(avg(memValues))} &nbsp; peak ${formatMB(Math.max(...memValues))} / ${formatMB(memTotal)}</summary>`);
  lines.push("");
  lines.push("```");
  lines.push(renderBarChart(memValues, 0, memTotal, 60));
  lines.push("```");
  lines.push("</details>");
  lines.push("");

  // Disk I/O
  if (showDisk && (Math.max(...diskRValues) > 0.1 || Math.max(...diskWValues) > 0.1)) {
    lines.push(`<details><summary><b>Disk I/O</b> — read avg ${avg(diskRValues).toFixed(1)} MB/s &nbsp; write avg ${avg(diskWValues).toFixed(1)} MB/s</summary>`);
    lines.push("");
    lines.push("```");
    const maxDisk = Math.max(Math.max(...diskRValues), Math.max(...diskWValues), 1);
    lines.push(`Read:  ${sparkline(diskRValues, 0, maxDisk)}`);
    lines.push(`Write: ${sparkline(diskWValues, 0, maxDisk)}`);
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }

  // Network
  if (showNetwork && (Math.max(...netInValues) > 0.1 || Math.max(...netOutValues) > 0.1)) {
    lines.push(`<details><summary><b>Network</b> — in avg ${avg(netInValues).toFixed(1)} MB/s &nbsp; out avg ${avg(netOutValues).toFixed(1)} MB/s</summary>`);
    lines.push("");
    lines.push("```");
    const maxNet = Math.max(Math.max(...netInValues), Math.max(...netOutValues), 1);
    lines.push(`↓ In:  ${sparkline(netInValues, 0, maxNet)}`);
    lines.push(`↑ Out: ${sparkline(netOutValues, 0, maxNet)}`);
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

function renderBarChart(values: number[], min: number, max: number, width: number): string {
  const sampled = downsample(values, width);
  const range = max - min || 1;
  const rows = 6;
  const lines: string[] = [];

  for (let row = rows; row >= 1; row--) {
    const threshold = min + (row / rows) * range;
    let line = "";
    for (const v of sampled) {
      line += v >= threshold ? "█" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function sparkline(values: number[], min: number, max: number): string {
  const blocks = " ▁▂▃▄▅▆▇█";
  const range = max - min || 1;
  const sampled = downsample(values, 50);
  return sampled
    .map((v) => {
      const idx = Math.min(8, Math.max(0, Math.floor(((v - min) / range) * 8)));
      return blocks[idx];
    })
    .join("");
}

function downsample(values: number[], target: number): number[] {
  if (values.length <= target) return values;
  const step = values.length / target;
  return Array.from({ length: target }, (_, i) => values[Math.floor(i * step)]);
}

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
  return `${Math.round(mb)}MB`;
}

run();
