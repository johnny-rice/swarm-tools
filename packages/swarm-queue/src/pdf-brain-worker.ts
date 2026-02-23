#!/usr/bin/env bun
/**
 * PDF Brain Queue Worker
 * Processes pdf-brain ingestion jobs from the queue
 */

import { SwarmWorker } from "./worker";
import { execSync } from "child_process";
import type { JobResult } from "./types";

interface PdfBrainJobData {
  path: string;
}

const worker = new SwarmWorker<PdfBrainJobData, { path: string; success: boolean }>(
  {
    queueName: process.env.SWARM_QUEUE_NAME || "pdf-ingest",
    connection: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
    concurrency: 1, // One at a time
  },
  async (job, runSandboxed): Promise<JobResult<{ path: string; success: boolean }>> => {
    const { path } = job.data.payload;
    console.log(`[pdf-brain] Processing: ${path}`);

    try {
      // Update progress
      await job.updateProgress({ stage: "ingesting", percent: 10 });

      // Run pdf-brain with nice priority
      const result = await runSandboxed("pdf-brain", ["add", path], {
        cpuNice: 10,
        memoryLimitMB: 8192,
        timeoutMs: 1800000, // 30 minutes
      });

      await job.updateProgress({ stage: "completed", percent: 100 });

      console.log(`[pdf-brain] Completed: ${path}`);
      return {
        success: true,
        data: { path, success: true },
        metadata: { stdout: result.stdout.slice(-1000) },
      };
    } catch (error) {
      console.error(`[pdf-brain] Failed: ${path}`, error);
      return {
        success: false,
        error: String(error),
        data: { path, success: false },
      };
    }
  }
);

console.log("PDF Brain worker started. Press Ctrl+C to stop.");
console.log(`Queue: ${process.env.SWARM_QUEUE_NAME || "pdf-ingest"}`);
console.log(`Concurrency: 1`);

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await worker.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
