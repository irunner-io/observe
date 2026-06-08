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

    if (!fs.existsSync(metricsFile)) {
      core.info("No metrics file found — skipping");
      return;
    }

    const lines = fs.readFileSync(metricsFile, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length < 3) {
      core.info("Not enough samples for metrics");
      return;
    }

    const samples: Sample[] = lines.map((l) => JSON.parse(l));
    const showDisk = core.getInput("show-disk") !== "false";
    const showNetwork = core.getInput("show-network") !== "false";

    // Render to step log (ASCII charts like RunsOn)
    renderToLog(samples, showDisk, showNetwork);

    // Also render to job summary (markdown)
    if (summaryFile) {
      const summary = renderMarkdownSummary(samples);
      fs.appendFileSync(summaryFile, summary);
    }

    // Set outputs
    const duration = samples[samples.length - 1].ts - samples[0].ts;
    const cpuValues = samples.map((s) => s.cpu);
    const memValues = samples.map((s) => s.mem_used_mb);

    core.setOutput("duration", String(duration));
    core.setOutput("cpu-avg", String(Math.round(avg(cpuValues))));
    core.setOutput("cpu-peak", String(Math.round(Math.max(...cpuValues))));
    core.setOutput("mem-avg-mb", String(Math.round(avg(memValues))));
    core.setOutput("mem-peak-mb", String(Math.round(Math.max(...memValues))));

    core.info(`\nMetrics collected: ${samples.length} samples over ${duration}s`);
  } catch (error) {
    core.debug(`Observe post error: ${error}`);
  }
}

function renderToLog(samples: Sample[], showDisk: boolean, showNetwork: boolean): void {
  const cpuValues = samples.map((s) => s.cpu);
  const memValues = samples.map((s) => s.mem_used_mb);
  const memTotal = samples[0].mem_total_mb;
  const diskRValues = samples.map((s) => s.disk_read_mbs);
  const diskWValues = samples.map((s) => s.disk_write_mbs);
  const netInValues = samples.map((s) => s.net_in_mbs);
  const netOutValues = samples.map((s) => s.net_out_mbs);

  const cpuPeak = Math.max(...cpuValues);
  const memPeak = Math.max(...memValues);

  console.log("");
  console.log("📊 Job Metrics");
  console.log("═".repeat(72));

  // Resource constraint detection
  if (cpuPeak > 95 || memPeak > memTotal * 0.9) {
    const constraints: string[] = [];
    if (cpuPeak > 95) constraints.push(`CPU saturated (${cpuPeak.toFixed(0)}%)`);
    if (memPeak > memTotal * 0.9) constraints.push(`Memory high (${formatMB(memPeak)}/${formatMB(memTotal)})`);
    console.log(`⚠️  Resource constraints detected: ${constraints.join(", ")}`);
  } else {
    console.log("✅ No significant resource constraints detected");
  }
  console.log("═".repeat(72));

  // CPU chart
  console.log("");
  renderAsciiChart(
    cpuValues,
    `CPU Utilization (min: ${Math.min(...cpuValues).toFixed(1)}%, max: ${cpuPeak.toFixed(1)}%, avg: ${avg(cpuValues).toFixed(1)}%)`,
    "%",
    0,
    100
  );

  // Memory chart
  console.log("");
  renderAsciiChart(
    memValues,
    `Memory Usage (min: ${formatMB(Math.min(...memValues))}, max: ${formatMB(memPeak)}, avg: ${formatMB(avg(memValues))}) / ${formatMB(memTotal)}`,
    "MB",
    0,
    memTotal
  );

  // Disk I/O chart
  if (showDisk && (Math.max(...diskRValues) > 0.1 || Math.max(...diskWValues) > 0.1)) {
    console.log("");
    const combined = diskRValues.map((r, i) => r + diskWValues[i]);
    renderAsciiChart(
      combined,
      `Disk I/O (read avg: ${avg(diskRValues).toFixed(1)} MB/s, write avg: ${avg(diskWValues).toFixed(1)} MB/s)`,
      "MB/s",
      0,
      Math.max(...combined)
    );
  }

  // Network chart
  if (showNetwork && (Math.max(...netInValues) > 0.1 || Math.max(...netOutValues) > 0.1)) {
    console.log("");
    const combined = netInValues.map((r, i) => r + netOutValues[i]);
    renderAsciiChart(
      combined,
      `Network I/O (in avg: ${avg(netInValues).toFixed(1)} MB/s, out avg: ${avg(netOutValues).toFixed(1)} MB/s)`,
      "MB/s",
      0,
      Math.max(...combined)
    );
  }

  console.log("");
}

function renderAsciiChart(values: number[], label: string, unit: string, min: number, max: number): void {
  const width = 60;
  const height = 12;
  const sampled = downsample(values, width);

  const range = max - min || 1;

  // Render chart rows (top to bottom)
  for (let row = height; row >= 1; row--) {
    const threshold = min + (row / height) * range;
    const yLabel = threshold.toFixed(threshold >= 100 ? 0 : threshold >= 10 ? 1 : 2);
    const padding = " ".repeat(Math.max(0, 7 - yLabel.length));

    let line = `${padding}${yLabel} ┤`;

    for (let col = 0; col < sampled.length; col++) {
      const val = sampled[col];
      const nextVal = col < sampled.length - 1 ? sampled[col + 1] : val;
      const prevVal = col > 0 ? sampled[col - 1] : val;

      const valRow = Math.ceil(((val - min) / range) * height);
      const nextRow = Math.ceil(((nextVal - min) / range) * height);

      if (valRow === row) {
        if (nextRow > row) {
          line += "╱";
        } else if (nextRow < row) {
          line += "╲";
        } else {
          line += "─";
        }
      } else if (valRow > row && Math.ceil(((prevVal - min) / range) * height) <= row) {
        line += "│";
      } else if (valRow < row && Math.ceil(((prevVal - min) / range) * height) >= row) {
        line += "│";
      } else {
        line += " ";
      }
    }
    console.log(line);
  }

  // X-axis
  const axisPadding = " ".repeat(8);
  console.log(`${axisPadding}└${"─".repeat(width)}`);
  console.log(`${axisPadding}  ${label}`);
}

function renderMarkdownSummary(samples: Sample[]): string {
  const duration = samples[samples.length - 1].ts - samples[0].ts;
  const memTotal = samples[0].mem_total_mb;
  const cpuValues = samples.map((s) => s.cpu);
  const memValues = samples.map((s) => s.mem_used_mb);

  const lines: string[] = [];
  lines.push("");
  lines.push("---");
  lines.push("### ⚡ IRunner Build Metrics");
  lines.push("");
  lines.push(`| Metric | Avg | Peak | Total |`);
  lines.push(`|--------|-----|------|-------|`);
  lines.push(`| CPU | ${avg(cpuValues).toFixed(0)}% | ${Math.max(...cpuValues).toFixed(0)}% | — |`);
  lines.push(`| Memory | ${formatMB(avg(memValues))} | ${formatMB(Math.max(...memValues))} | ${formatMB(memTotal)} |`);
  lines.push("");
  lines.push(`*Duration: ${formatDuration(duration)} | Samples: ${samples.length}*`);
  lines.push("");
  return lines.join("\n");
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
