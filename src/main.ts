import * as core from "@actions/core";
import * as fs from "fs";
import { execSync } from "child_process";

async function run(): Promise<void> {
  try {
    // Record start time
    core.saveState("observe_start_ms", String(Date.now()));

    // Print runner instance metadata
    printInstanceMetadata();

    // Verify metrics collector
    const metricsFile = "/tmp/ir-metrics.jsonl";
    if (fs.existsSync("/tmp/ir-metrics-collector.pid")) {
      const pid = fs.readFileSync("/tmp/ir-metrics-collector.pid", "utf-8").trim();
      core.info(`Metrics collector active (pid: ${pid})`);
    } else if (fs.existsSync(metricsFile)) {
      core.info("Metrics file detected");
    } else {
      core.info("Metrics collector not detected — charts will not render");
    }
  } catch (error) {
    core.debug(`Observe setup error: ${error}`);
  }
}

function printInstanceMetadata(): void {
  console.log("");
  console.log("▼ Runner Instance");

  const info: [string, string][] = [];

  // Instance metadata from IMDS (EC2)
  const imds = getIMDS();
  if (imds.instanceId) {
    info.push(["InstanceId", imds.instanceId]);
    info.push(["InstanceType", imds.instanceType]);
    info.push(["Region", imds.region]);
    info.push(["AvailabilityZone", imds.az]);
    info.push(["InstanceLifecycle", imds.lifecycle]);
    if (imds.ami) info.push(["ImageId", imds.ami]);
  }

  // System info
  const cpuCores = getCPUCores();
  const totalMem = getTotalMemMB();
  const diskInfo = getDiskInfo();

  info.push(["Platform", "linux"]);
  info.push(["Architecture", getArch()]);
  info.push(["CPU", `${cpuCores} cores`]);
  info.push(["RAM", `${totalMem} MiB`]);
  if (diskInfo) info.push(["Disk", diskInfo]);

  // IR-specific info
  if (fs.existsSync("/etc/ir/cache-url")) {
    const cacheUrl = fs.readFileSync("/etc/ir/cache-url", "utf-8").trim();
    info.push(["CacheEndpoint", cacheUrl]);
  }

  const privateIP = getPrivateIP();
  if (privateIP) info.push(["PrivateIp", privateIP]);

  // Render table
  if (info.length > 0) {
    const maxKey = Math.max(...info.map(([k]) => k.length));
    const maxVal = Math.max(...info.map(([, v]) => v.length));

    console.log(`| ${"INFO".padEnd(maxKey)} | ${"VALUE".padEnd(maxVal)} |`);
    console.log(`|${"-".repeat(maxKey + 2)}|${"-".repeat(maxVal + 2)}|`);
    for (const [key, val] of info) {
      console.log(`| ${key.padEnd(maxKey)} | ${val.padEnd(maxVal)} |`);
    }
  }
  console.log("");
}

interface IMDSData {
  instanceId: string;
  instanceType: string;
  region: string;
  az: string;
  lifecycle: string;
  ami: string;
}

function getIMDS(): IMDSData {
  const result: IMDSData = { instanceId: "", instanceType: "", region: "", az: "", lifecycle: "on-demand", ami: "" };

  try {
    // Get IMDSv2 token
    const token = execSync(
      'curl -sf -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null',
      { timeout: 2000 }
    ).toString().trim();

    const headers = `-H "X-aws-ec2-metadata-token: ${token}"`;
    const base = "http://169.254.169.254/latest/meta-data";

    result.instanceId = execSync(`curl -sf ${headers} ${base}/instance-id 2>/dev/null`, { timeout: 2000 }).toString().trim();
    result.instanceType = execSync(`curl -sf ${headers} ${base}/instance-type 2>/dev/null`, { timeout: 2000 }).toString().trim();
    result.az = execSync(`curl -sf ${headers} ${base}/placement/availability-zone 2>/dev/null`, { timeout: 2000 }).toString().trim();
    result.region = result.az.slice(0, -1); // us-west-1a → us-west-1
    result.ami = execSync(`curl -sf ${headers} ${base}/ami-id 2>/dev/null`, { timeout: 2000 }).toString().trim();

    // Check spot
    const lifecycle = execSync(`curl -sf ${headers} ${base}/instance-life-cycle 2>/dev/null`, { timeout: 2000 }).toString().trim();
    result.lifecycle = lifecycle || "on-demand";
  } catch {
    // Not on EC2 or IMDS unavailable
  }

  return result;
}

function getCPUCores(): string {
  try {
    return execSync("nproc 2>/dev/null", { timeout: 1000 }).toString().trim();
  } catch {
    return "unknown";
  }
}

function getTotalMemMB(): string {
  try {
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const match = meminfo.match(/MemTotal:\s+(\d+)/);
    if (match) {
      return String(Math.round(parseInt(match[1]) / 1024));
    }
  } catch {}
  return "unknown";
}

function getDiskInfo(): string {
  try {
    const df = execSync("df -h / 2>/dev/null | tail -1", { timeout: 1000 }).toString().trim();
    const parts = df.split(/\s+/);
    if (parts.length >= 4) {
      return `Free=${parts[3]} Used=${parts[2]} Total=${parts[1]}`;
    }
  } catch {}
  return "";
}

function getArch(): string {
  try {
    return execSync("uname -m 2>/dev/null", { timeout: 1000 }).toString().trim();
  } catch {
    return "x86_64";
  }
}

function getPrivateIP(): string {
  try {
    return execSync("hostname -I 2>/dev/null | awk '{print $1}'", { timeout: 1000 }).toString().trim();
  } catch {
    return "";
  }
}

run();
