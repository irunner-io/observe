import * as core from "@actions/core";
import * as fs from "fs";
import { execSync } from "child_process";

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

// GitHub Actions market rates ($/min) for "what GitHub would charge" comparison
const GITHUB_RATE_PER_MIN: Record<string, number> = {
  linux: 0.008,
  windows: 0.016,
  macos: 0.08,
};

// On-demand pricing ($/hour) — used when spot price unavailable
const ON_DEMAND_PRICING: Record<string, number> = {
  "m7i.medium": 0.0504,
  "m7i.large": 0.1008,
  "m7i.xlarge": 0.2016,
  "m7i.2xlarge": 0.4032,
  "m7i.4xlarge": 0.8064,
  "m6i.large": 0.096,
  "m6i.xlarge": 0.192,
  "c7i.large": 0.0892,
  "c7i.xlarge": 0.1785,
  "t3.medium": 0.0416,
  "t3.large": 0.0832,
  "t3.xlarge": 0.1664,
  "t4g.micro": 0.0084,
  "t4g.small": 0.0168,
  "t4g.medium": 0.0336,
  "t4g.large": 0.0672,
  "t4g.xlarge": 0.1344,
};

// Spot discount estimate (conservative — actual price from SpotPriceCache is better)
const SPOT_DISCOUNT = 0.7; // spot is typically 30-70% cheaper

async function run(): Promise<void> {
  try {
    const metricsFile = "/tmp/ir-metrics.jsonl";
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;

    // Calculate job duration from saved state
    const startMs = parseInt(core.getState("observe_start_ms") || "0");
    const durationSec = startMs > 0 ? Math.round((Date.now() - startMs) / 1000) : 0;

    // Render IRcoin cost (always — doesn't depend on metrics collector)
    const showCost = core.getInput("show-cost") !== "false";
    if (showCost && durationSec > 0) {
      const costResult = renderCost(durationSec);
      if (costResult && summaryFile) {
        fs.appendFileSync(summaryFile, costResult.markdown);
      }
      if (costResult) {
        core.setOutput("cost-actual", String(costResult.actualCoins));
        core.setOutput("cost-github-equiv", String(costResult.githubCoins));
        core.setOutput("cost-savings-pct", String(costResult.savingsPct));
      }
    }

    if (!fs.existsSync(metricsFile)) {
      core.info("No metrics file found — skipping resource charts");
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

interface CostResult {
  actualCoins: number;
  githubCoins: number;
  savingsPct: number;
  markdown: string;
}

interface ServerCost {
  instance_type?: string;
  is_spot?: boolean;
  price_per_hour?: number;
  compute_cents?: number;
  cache_download_bytes?: number;
  cache_upload_bytes?: number;
  cache_transfer_cents?: number;
  actual_total_cents?: number;
  github_equiv_cents?: number;
  unavailable?: string[];
}

function fetchServerCost(jobID: string): ServerCost | null {
  const cacheUrl = process.env.IR_CACHE_URL || process.env.ACTIONS_CACHE_URL || "";
  if (!cacheUrl || !jobID) return null;

  const baseUrl = cacheUrl.replace(/\/cache\/?$/, "");
  try {
    const result = execSync(
      `curl -sf --max-time 3 "${baseUrl}/internal/job-cost/gh-${jobID}" 2>/dev/null`,
      { timeout: 5000 }
    ).toString().trim();
    if (!result) return null;
    return JSON.parse(result);
  } catch {
    return null;
  }
}

function renderCost(durationSec: number): CostResult | null {
  const instanceType = getIMDSField("instance-type");
  if (!instanceType) return null;

  const lifecycle = getIMDSField("instance-life-cycle") || "on-demand";
  const isSpot = lifecycle === "spot";
  const os = "linux";

  // Try fetching server-computed cost (graceful failure)
  // Extract numeric job ID from runner name (format: ir-{runID}-{jobID})
  const runnerName = process.env.RUNNER_NAME || "";
  const runnerParts = runnerName.split("-");
  const platformJobID = runnerParts.length >= 3 && runnerParts[0] === "ir"
    ? runnerParts[runnerParts.length - 1]
    : "";
  const serverCost = fetchServerCost(platformJobID);

  // Resolve price: server > local table > null
  let pricePerHour: number | null = null;
  let priceSource = "";
  let computeCents: number | null = null;
  let cacheDownloadBytes: number | null = null;
  let cacheUploadBytes: number | null = null;
  let cacheTransferCents: number | null = null;

  if (serverCost && serverCost.price_per_hour) {
    pricePerHour = serverCost.price_per_hour;
    priceSource = serverCost.is_spot ? "spot (actual)" : "on-demand";
    computeCents = serverCost.compute_cents || null;
    cacheDownloadBytes = serverCost.cache_download_bytes || null;
    cacheUploadBytes = serverCost.cache_upload_bytes || null;
    cacheTransferCents = serverCost.cache_transfer_cents || null;
  } else if (isSpot) {
    const onDemand = ON_DEMAND_PRICING[instanceType];
    if (onDemand) {
      pricePerHour = onDemand * (1 - SPOT_DISCOUNT);
      priceSource = "spot (estimated)";
    }
  } else {
    pricePerHour = ON_DEMAND_PRICING[instanceType] || null;
    priceSource = "on-demand";
  }

  // GitHub equivalent
  const githubRate = GITHUB_RATE_PER_MIN[os] || 0.008;
  const githubCoins = serverCost?.github_equiv_cents
    || Math.ceil(githubRate * (durationSec / 60) * 100);

  // Actual cost
  let actualCoins: number | null = computeCents;
  if (actualCoins === null && pricePerHour !== null) {
    actualCoins = Math.ceil(pricePerHour * (durationSec / 3600) * 100);
  }

  // Add cache transfer to total if available
  let totalCoins = actualCoins;
  if (totalCoins !== null && cacheTransferCents) {
    totalCoins += cacheTransferCents;
  }

  const displayCoins = totalCoins ?? actualCoins;
  const savingsPct = displayCoins !== null && githubCoins > 0
    ? Math.round(((githubCoins - displayCoins) / githubCoins) * 100)
    : 0;

  // Render to console
  console.log("");
  console.log("💰 Build Cost (IRcoins)");
  console.log("═".repeat(56));
  console.log(`  GitHub would charge:     ${githubCoins} coins ($${(githubCoins / 100).toFixed(2)})`);
  if (displayCoins !== null) {
    console.log(`  Your actual cost:        ${displayCoins} coins ($${(displayCoins / 100).toFixed(2)})`);
    console.log(`  Savings:                 ${githubCoins - displayCoins} coins (${savingsPct}% less)`);
  } else {
    console.log(`  Your actual cost:        ⚠️ data not available`);
  }
  console.log("─".repeat(56));
  console.log(`  Breakdown:`);
  if (pricePerHour !== null) {
    console.log(`    Compute (${instanceType} ${priceSource}, ${formatDuration(durationSec)})  ${actualCoins} coins`);
  } else {
    console.log(`    Compute (${instanceType})  ⚠️ price not in table`);
  }
  if (cacheDownloadBytes !== null || cacheUploadBytes !== null) {
    const dlMB = cacheDownloadBytes ? (cacheDownloadBytes / 1048576).toFixed(1) : "0";
    const ulMB = cacheUploadBytes ? (cacheUploadBytes / 1048576).toFixed(1) : "0";
    const cacheCost = cacheTransferCents ? `${cacheTransferCents} coins` : "included";
    console.log(`    Cache transfer (↓${dlMB}MB ↑${ulMB}MB)  ${cacheCost}`);
  } else {
    console.log(`    Cache transfer          ⚠️ data not available`);
  }
  console.log(`    Network egress          ⚠️ not metered`);
  console.log("═".repeat(56));
  console.log("");

  // Markdown for job summary
  const mdLines: string[] = [];
  mdLines.push("");
  mdLines.push("---");
  mdLines.push("### 💰 Build Cost (IRcoins)");
  mdLines.push("");
  mdLines.push(`| | Coins | USD |`);
  mdLines.push(`|--|-------|-----|`);
  mdLines.push(`| GitHub would charge | ${githubCoins} | $${(githubCoins / 100).toFixed(2)} |`);
  if (displayCoins !== null) {
    mdLines.push(`| **Your actual cost** | **${displayCoins}** | **$${(displayCoins / 100).toFixed(2)}** |`);
    mdLines.push(`| **Savings** | **${githubCoins - displayCoins}** | **${savingsPct}% less** |`);
  } else {
    mdLines.push(`| Your actual cost | — | data not available |`);
  }
  mdLines.push("");
  mdLines.push(`<details><summary>Breakdown</summary>`);
  mdLines.push("");
  mdLines.push(`| Component | Value |`);
  mdLines.push(`|-----------|-------|`);
  mdLines.push(`| Instance | ${instanceType} (${lifecycle}) |`);
  mdLines.push(`| Duration | ${formatDuration(durationSec)} |`);
  if (pricePerHour !== null) {
    mdLines.push(`| Compute | ${actualCoins} coins ($${pricePerHour.toFixed(4)}/hr × ${(durationSec / 3600).toFixed(3)}hr) |`);
  }
  if (cacheDownloadBytes !== null || cacheUploadBytes !== null) {
    const dlMB = cacheDownloadBytes ? (cacheDownloadBytes / 1048576).toFixed(1) : "0";
    const ulMB = cacheUploadBytes ? (cacheUploadBytes / 1048576).toFixed(1) : "0";
    mdLines.push(`| Cache | ↓${dlMB}MB ↑${ulMB}MB (${cacheTransferCents || 0} coins) |`);
  } else {
    mdLines.push(`| Cache transfer | not metered |`);
  }
  mdLines.push(`| Network egress | not metered |`);
  mdLines.push("");
  mdLines.push(`*1 IRcoin = 1 cent USD.*`);
  mdLines.push(`</details>`);
  mdLines.push("");

  return {
    actualCoins: displayCoins || 0,
    githubCoins,
    savingsPct,
    markdown: mdLines.join("\n"),
  };
}

function getIMDSField(field: string): string {
  try {
    const token = execSync(
      'curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null',
      { timeout: 2000 }
    ).toString().trim();

    return execSync(
      `curl -sf -H "X-aws-ec2-metadata-token: ${token}" http://169.254.169.254/latest/meta-data/${field} 2>/dev/null`,
      { timeout: 2000 }
    ).toString().trim();
  } catch {
    return "";
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
  const width = 70;
  const sampled = downsample(values, width);
  const range = max - min || 1;
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  // Sparkline bar chart — each column is one block character (8 levels)
  const barHeight = 8;
  const rows: string[] = [];

  for (let row = barHeight; row >= 1; row--) {
    let line = "";
    for (let col = 0; col < sampled.length; col++) {
      const normalized = (sampled[col] - min) / range;
      const filledRows = normalized * barHeight;

      if (filledRows >= row) {
        line += "█";
      } else if (filledRows >= row - 1 && filledRows < row) {
        const frac = filledRows - (row - 1);
        const blockIdx = Math.round(frac * 8);
        line += blocks[Math.min(blockIdx, 8)];
      } else {
        line += " ";
      }
    }
    rows.push(line);
  }

  // Y-axis labels (top, mid, bottom)
  const maxLabel = max.toFixed(max >= 100 ? 0 : 1);
  const midLabel = ((max + min) / 2).toFixed((max + min) / 2 >= 100 ? 0 : 1);
  const minLabel = min.toFixed(min >= 100 ? 0 : 1);
  const labelWidth = Math.max(maxLabel.length, midLabel.length, minLabel.length) + 1;

  for (let i = 0; i < rows.length; i++) {
    let yLabel = "";
    if (i === 0) yLabel = maxLabel;
    else if (i === Math.floor(rows.length / 2)) yLabel = midLabel;
    else if (i === rows.length - 1) yLabel = minLabel;

    const pad = " ".repeat(labelWidth - yLabel.length);
    console.log(`${pad}${yLabel} │${rows[i]}│`);
  }

  // Time axis
  const duration = values.length;
  const pad = " ".repeat(labelWidth + 1);
  console.log(`${pad}└${"─".repeat(width)}┘`);
  console.log(`${pad} 0s${" ".repeat(Math.max(0, width - 6 - String(duration).length))}${duration}s`);
  console.log(`${pad} ${label}`);
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
