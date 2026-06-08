import * as core from "@actions/core";
import * as fs from "fs";

async function run(): Promise<void> {
  try {
    const metricsFile = "/tmp/ir-metrics.jsonl";

    // Verify metrics collector is running
    if (fs.existsSync("/tmp/ir-metrics-collector.pid")) {
      const pid = fs.readFileSync("/tmp/ir-metrics-collector.pid", "utf-8").trim();
      core.info(`IRunner metrics collector active (pid: ${pid})`);
    } else if (fs.existsSync(metricsFile)) {
      core.info("IRunner metrics file detected");
    } else {
      core.info("IRunner metrics collector not detected — metrics will not be rendered");
      core.info("Ensure metrics_collector: true is set in your pool config");
    }

    // Record start time for duration calculation
    core.saveState("observe_start_ms", String(Date.now()));
  } catch (error) {
    // Never fail the job for observability
    core.debug(`Observe setup error: ${error}`);
  }
}

run();
