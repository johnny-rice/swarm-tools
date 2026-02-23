#!/usr/bin/env bun
/**
 * Hivemind Embedding Backfill - Job Submission Script
 * 
 * Queries all memories without embeddings and submits them to the
 * `hivemind-backfill` queue for processing.
 * 
 * Features:
 * - Idempotent: skips memories that already have a queued/active job
 * - Batch submission: submits in batches to avoid overwhelming Redis
 * - Progress tracking: shows real-time submission progress
 * - Dry run: preview what would be submitted
 * 
 * Usage:
 *   bun run scripts/backfill-submit.ts [--dry-run] [--limit=1000] [--batch=100]
 * 
 * Environment:
 *   REDIS_HOST - Redis host (default: localhost)
 *   REDIS_PORT - Redis port (default: 6379)
 */

import { createClient } from "@libsql/client";
import { createSwarmQueue } from "../../swarm-queue/src/index";
import { resolve } from "path";
import { homedir } from "os";

// ============================================================================
// Configuration
// ============================================================================

const QUEUE_NAME = "hivemind-backfill";

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find(a => a.startsWith("--limit="));
const batchArg = args.find(a => a.startsWith("--batch="));

const LIMIT = limitArg ? parseInt(limitArg.split("=")[1]) : Infinity;
const BATCH_SIZE = batchArg ? parseInt(batchArg.split("=")[1]) : 100;

const dbPath = resolve(homedir(), ".config/swarm-tools/swarm.db");

// ============================================================================
// Database Client
// ============================================================================

const db = createClient({ url: `file:${dbPath}` });

interface MemoryRow {
  id: string;
  content_length: number;
  created_at: string;
}

async function getMemoriesWithoutEmbeddings(limit: number): Promise<MemoryRow[]> {
  const result = await db.execute({
    sql: `
      SELECT id, LENGTH(content) as content_length, created_at
      FROM memories 
      WHERE embedding IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `,
    args: [limit === Infinity ? 1000000 : limit],
  });
  
  return result.rows.map(row => ({
    id: row.id as string,
    content_length: row.content_length as number,
    created_at: row.created_at as string,
  }));
}

async function getTotalMissingCount(): Promise<number> {
  const result = await db.execute(
    "SELECT COUNT(id) as count FROM memories WHERE embedding IS NULL"
  );
  return Number(result.rows[0].count);
}

// ============================================================================
// Queue Client
// ============================================================================

const queue = createSwarmQueue({
  name: QUEUE_NAME,
  connection: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000, // Start at 2s, then 4s, 8s
    },
    removeOnComplete: 100, // Keep last 100 completed for debugging
    removeOnFail: 500, // Keep more failed jobs for analysis
  },
});

// ============================================================================
// Submission Logic
// ============================================================================

async function submitBatch(memories: MemoryRow[]): Promise<{ submitted: number; skipped: number }> {
  let submitted = 0;
  let skipped = 0;
  
  for (const memory of memories) {
    // Generate deterministic job ID based on memory ID
    // This enables idempotency - re-running the script won't create duplicates
    const jobId = `embed-${memory.id}`;
    
    try {
      // Check if job already exists
      const existingJob = await queue.getJob(jobId);
      if (existingJob) {
        const state = await existingJob.getState();
        if (state === "waiting" || state === "active" || state === "delayed") {
          // Job already queued/running, skip
          skipped++;
          continue;
        }
        // Job completed/failed - can be resubmitted
        if (state === "completed") {
          skipped++;
          continue;
        }
        // Failed job - remove and resubmit
        await queue.removeJob(jobId);
      }
      
      // Submit job
      await queue.addJob(
        "embed-memory",
        { memoryId: memory.id },
        {
          jobId,
          priority: 2, // Normal priority
        }
      );
      submitted++;
    } catch (error) {
      console.error(`Error submitting job for ${memory.id}:`, error);
    }
  }
  
  return { submitted, skipped };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("📤 Hivemind Backfill - Job Submission");
  console.log(`   Queue: ${QUEUE_NAME}`);
  console.log(`   Database: ${dbPath}`);
  console.log(`   Limit: ${LIMIT === Infinity ? "unlimited" : LIMIT}`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  console.log(`   Dry run: ${dryRun}`);
  console.log();
  
  // Get current queue metrics
  const metrics = await queue.getMetrics();
  console.log("📊 Current Queue Status:");
  console.log(`   Waiting: ${metrics.waiting}`);
  console.log(`   Active: ${metrics.active}`);
  console.log(`   Completed: ${metrics.completed}`);
  console.log(`   Failed: ${metrics.failed}`);
  console.log();
  
  // Count total missing embeddings
  const totalMissing = await getTotalMissingCount();
  console.log(`📊 Memories without embeddings: ${totalMissing}`);
  
  if (totalMissing === 0) {
    console.log("✅ All memories have embeddings!");
    await queue.close();
    return;
  }
  
  const toProcess = Math.min(totalMissing, LIMIT);
  console.log(`🎯 Will submit: ${toProcess} memories\n`);
  
  if (dryRun) {
    console.log("🔍 DRY RUN - no jobs will be submitted\n");
    
    // Show sample
    const sample = await getMemoriesWithoutEmbeddings(5);
    console.log("Sample memories to process:");
    for (const mem of sample) {
      console.log(`  - ${mem.id} (${mem.content_length} chars, created: ${mem.created_at})`);
    }
    
    await queue.close();
    return;
  }
  
  // Fetch and submit in batches
  let totalSubmitted = 0;
  let totalSkipped = 0;
  const startTime = Date.now();
  
  // Fetch all memories first
  console.log("📥 Fetching memories without embeddings...");
  const memories = await getMemoriesWithoutEmbeddings(toProcess);
  console.log(`   Found: ${memories.length} memories\n`);
  
  // Submit in batches
  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(memories.length / BATCH_SIZE);
    
    process.stdout.write(`📦 Submitting batch ${batchNum}/${totalBatches}...`);
    
    const { submitted, skipped } = await submitBatch(batch);
    totalSubmitted += submitted;
    totalSkipped += skipped;
    
    console.log(` ✅ submitted: ${submitted}, skipped: ${skipped}`);
    
    // Small delay between batches to avoid overwhelming Redis
    if (i + BATCH_SIZE < memories.length) {
      await new Promise(r => setTimeout(r, 50));
    }
  }
  
  // Summary
  const elapsed = (Date.now() - startTime) / 1000;
  console.log("\n" + "=".repeat(50));
  console.log("📊 SUBMISSION COMPLETE");
  console.log(`   Total submitted: ${totalSubmitted}`);
  console.log(`   Skipped (already queued): ${totalSkipped}`);
  console.log(`   Duration: ${elapsed.toFixed(1)}s`);
  console.log(`   Rate: ${(totalSubmitted / elapsed).toFixed(1)} jobs/sec`);
  
  // Final queue metrics
  const finalMetrics = await queue.getMetrics();
  console.log("\n📊 Updated Queue Status:");
  console.log(`   Waiting: ${finalMetrics.waiting}`);
  console.log(`   Active: ${finalMetrics.active}`);
  console.log(`   Completed: ${finalMetrics.completed}`);
  console.log(`   Failed: ${finalMetrics.failed}`);
  
  // Show next steps
  console.log("\n📋 Next Steps:");
  console.log("   1. Start worker(s): bun run scripts/backfill-worker.ts --concurrency=2");
  console.log("   2. Monitor progress: swarm queue list hivemind-backfill --state waiting");
  console.log("   3. Check failures: swarm queue list hivemind-backfill --state failed");
  
  await queue.close();
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
