#!/usr/bin/env bun
/**
 * Hivemind Embedding Backfill - Status Checker
 * 
 * Shows the current state of the backfill queue and database.
 * 
 * Usage:
 *   bun run scripts/backfill-status.ts [--verbose]
 * 
 * Output:
 *   - Database: how many memories still need embeddings
 *   - Queue: waiting/active/completed/failed counts
 *   - ETA: rough estimate based on completion rate
 */

import { createClient } from "@libsql/client";
import { createSwarmQueue } from "../../swarm-queue/src/index";
import { resolve } from "path";
import { homedir } from "os";

// ============================================================================
// Configuration
// ============================================================================

const QUEUE_NAME = "hivemind-backfill";
const verbose = process.argv.includes("--verbose");

const dbPath = resolve(homedir(), ".config/swarm-tools/swarm.db");

// ============================================================================
// Clients
// ============================================================================

const db = createClient({ url: `file:${dbPath}` });

const queue = createSwarmQueue({
  name: QUEUE_NAME,
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  },
});

// ============================================================================
// Queries
// ============================================================================

async function getDatabaseStats() {
  const [total, withEmbedding, without] = await Promise.all([
    db.execute("SELECT COUNT(id) as count FROM memories"),
    db.execute("SELECT COUNT(id) as count FROM memories WHERE embedding IS NOT NULL"),
    db.execute("SELECT COUNT(id) as count FROM memories WHERE embedding IS NULL"),
  ]);
  
  return {
    total: Number(total.rows[0].count),
    withEmbedding: Number(withEmbedding.rows[0].count),
    without: Number(without.rows[0].count),
  };
}

async function getRecentlyFailed(limit = 5) {
  // Get failed jobs from queue
  const jobs = await queue.underlying.getFailed(0, limit - 1);
  return jobs.map(job => ({
    id: job.id,
    memoryId: job.data?.payload?.memoryId,
    reason: job.failedReason,
    attempts: job.attemptsMade,
    timestamp: job.finishedOn ? new Date(job.finishedOn).toISOString() : "unknown",
  }));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("📊 Hivemind Backfill Status\n");
  
  // Database stats
  const dbStats = await getDatabaseStats();
  const completionPercent = ((dbStats.withEmbedding / dbStats.total) * 100).toFixed(1);
  
  console.log("💾 Database:");
  console.log(`   Total memories: ${dbStats.total.toLocaleString()}`);
  console.log(`   With embeddings: ${dbStats.withEmbedding.toLocaleString()} (${completionPercent}%)`);
  console.log(`   Without embeddings: ${dbStats.without.toLocaleString()}`);
  console.log();
  
  // Queue stats
  const metrics = await queue.getMetrics();
  const totalQueued = metrics.waiting + metrics.active + metrics.delayed;
  const totalProcessed = metrics.completed + metrics.failed;
  
  console.log("📬 Queue:");
  console.log(`   Waiting: ${metrics.waiting.toLocaleString()}`);
  console.log(`   Active: ${metrics.active.toLocaleString()}`);
  console.log(`   Delayed: ${metrics.delayed.toLocaleString()}`);
  console.log(`   Completed: ${metrics.completed.toLocaleString()}`);
  console.log(`   Failed: ${metrics.failed.toLocaleString()}`);
  console.log();
  
  // Progress
  if (totalProcessed > 0) {
    const successRate = ((metrics.completed / totalProcessed) * 100).toFixed(1);
    console.log("📈 Progress:");
    console.log(`   Success rate: ${successRate}%`);
    
    if (metrics.waiting > 0 && metrics.completed > 0) {
      // Rough ETA based on completion rate (assume ~1 job/sec with default concurrency)
      const estimatedJobsPerSec = 1; // Conservative estimate
      const etaSeconds = metrics.waiting / estimatedJobsPerSec;
      const etaMinutes = etaSeconds / 60;
      
      if (etaMinutes < 60) {
        console.log(`   Estimated time remaining: ~${etaMinutes.toFixed(0)} minutes`);
      } else {
        console.log(`   Estimated time remaining: ~${(etaMinutes / 60).toFixed(1)} hours`);
      }
    }
    console.log();
  }
  
  // Failed jobs (if any)
  if (metrics.failed > 0 && verbose) {
    console.log("❌ Recent Failures:");
    const failed = await getRecentlyFailed(5);
    for (const job of failed) {
      console.log(`   - ${job.memoryId || job.id}`);
      console.log(`     Reason: ${job.reason?.slice(0, 80) || "unknown"}`);
      console.log(`     Attempts: ${job.attempts}`);
    }
    console.log();
  } else if (metrics.failed > 0) {
    console.log(`⚠️  ${metrics.failed} jobs failed. Run with --verbose to see details.`);
    console.log();
  }
  
  // Overall status
  if (dbStats.without === 0) {
    console.log("✅ All memories have embeddings!");
  } else if (totalQueued === 0 && metrics.failed === 0) {
    console.log("💡 Ready to start. Run:");
    console.log("   bun run scripts/backfill-submit.ts");
    console.log("   bun run scripts/backfill-worker.ts");
  } else if (metrics.active > 0) {
    console.log("🔄 Backfill in progress...");
  } else if (metrics.waiting > 0) {
    console.log("⏳ Jobs queued but no active workers. Start worker:");
    console.log("   bun run scripts/backfill-worker.ts --concurrency=2");
  } else if (metrics.failed > 0) {
    console.log("⚠️  Some jobs failed. Check with --verbose or resubmit:");
    console.log("   bun run scripts/backfill-submit.ts  # Will retry failed jobs");
  }
  
  await queue.close();
}

main().catch(e => {
  console.error("Error:", e);
  process.exit(1);
});
