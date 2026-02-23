#!/usr/bin/env bun
/**
 * Hivemind Embedding Backfill Worker
 * 
 * Processes embedding generation jobs from the `hivemind-backfill` queue.
 * Uses BullMQ for reliable job processing with exponential backoff.
 * 
 * Usage:
 *   bun run scripts/backfill-worker.ts [--concurrency=2]
 * 
 * Environment:
 *   REDIS_HOST - Redis host (default: localhost)
 *   REDIS_PORT - Redis port (default: 6379)
 *   OLLAMA_HOST - Ollama server URL (default: http://localhost:11434)
 *   OLLAMA_MODEL - Embedding model (default: mxbai-embed-large)
 */

import { createClient } from "@libsql/client";
import { SwarmWorker, type JobResult } from "../../swarm-queue/src/index";
import { resolve } from "path";
import { homedir } from "os";

// ============================================================================
// Configuration
// ============================================================================

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "mxbai-embed-large";
const EMBEDDING_DIM = 1024;
const QUEUE_NAME = "hivemind-backfill";

// Parse CLI args
const args = process.argv.slice(2);
const concurrencyArg = args.find(a => a.startsWith("--concurrency="));
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split("=")[1]) : 2;

const dbPath = resolve(homedir(), ".config/swarm-tools/swarm.db");

// ============================================================================
// Types
// ============================================================================

interface EmbedJobPayload {
  memoryId: string;
  content?: string; // Optional - worker can fetch from DB if not provided
}

interface EmbedJobResult {
  memoryId: string;
  success: boolean;
  embeddingDim?: number;
  error?: string;
}

// ============================================================================
// Ollama Embedding
// ============================================================================

async function generateEmbedding(text: string): Promise<number[] | null> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: text.slice(0, 24000), // Truncate to max chars
        }),
      });

      if (response.status >= 500) {
        // Server error - retry with backoff
        lastError = new Error(`Ollama server error: ${response.status}`);
        const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`[worker] Ollama 5xx error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        // Client error - don't retry
        const errorText = await response.text();
        throw new Error(`Ollama error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      return data.embedding;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Ollama error")) {
        throw error; // Don't retry client errors
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`[worker] Embedding error, retrying in ${delay}ms: ${lastError.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  throw lastError || new Error("Failed to generate embedding after retries");
}

// ============================================================================
// Database Client
// ============================================================================

const db = createClient({ url: `file:${dbPath}` });

async function getMemoryContent(id: string): Promise<string | null> {
  const result = await db.execute({
    sql: "SELECT content FROM memories WHERE id = ?",
    args: [id],
  });
  
  if (result.rows.length === 0) return null;
  return result.rows[0].content as string;
}

async function updateEmbedding(id: string, embedding: number[]): Promise<void> {
  const vectorStr = JSON.stringify(embedding);
  await db.execute({
    sql: `UPDATE memories SET embedding = vector(?) WHERE id = ?`,
    args: [vectorStr, id],
  });
}

async function hasEmbedding(id: string): Promise<boolean> {
  const result = await db.execute({
    sql: "SELECT embedding IS NOT NULL as has_embedding FROM memories WHERE id = ?",
    args: [id],
  });
  
  if (result.rows.length === 0) return true; // Memory doesn't exist, skip
  return Boolean(result.rows[0].has_embedding);
}

// ============================================================================
// Worker
// ============================================================================

console.log("🚀 Hivemind Backfill Worker Starting...");
console.log(`   Queue: ${QUEUE_NAME}`);
console.log(`   Concurrency: ${CONCURRENCY}`);
console.log(`   Database: ${dbPath}`);
console.log(`   Ollama: ${OLLAMA_HOST} (${OLLAMA_MODEL})`);
console.log();

// Check Ollama health before starting
try {
  const health = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!health.ok) throw new Error("Ollama not responding");
  console.log("✅ Ollama is running");
} catch (e) {
  console.error("❌ Ollama is not available at", OLLAMA_HOST);
  process.exit(1);
}

const worker = new SwarmWorker<EmbedJobPayload, EmbedJobResult>(
  {
    queueName: QUEUE_NAME,
    connection: {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
    },
    concurrency: CONCURRENCY,
    enableSandbox: false, // No sandboxing needed for embedding generation
  },
  async (job, _runSandboxed): Promise<JobResult<EmbedJobResult>> => {
    const { memoryId, content: providedContent } = job.data.payload;
    
    console.log(`[job ${job.id}] Processing memory: ${memoryId}`);
    
    try {
      // Check if already has embedding (idempotency)
      if (await hasEmbedding(memoryId)) {
        console.log(`[job ${job.id}] ⏭️ Already has embedding, skipping`);
        return {
          success: true,
          data: { memoryId, success: true },
          metadata: { skipped: true, reason: "already_embedded" },
        };
      }
      
      await job.updateProgress({ stage: "fetching", percent: 10 });
      
      // Get content (from job payload or DB)
      const content = providedContent || await getMemoryContent(memoryId);
      if (!content) {
        console.log(`[job ${job.id}] ❌ Memory not found`);
        return {
          success: false,
          error: `Memory ${memoryId} not found`,
          data: { memoryId, success: false, error: "not_found" },
        };
      }
      
      await job.updateProgress({ stage: "embedding", percent: 30 });
      
      // Generate embedding
      const embedding = await generateEmbedding(content);
      
      if (!embedding || embedding.length !== EMBEDDING_DIM) {
        const err = `Invalid embedding dimension: ${embedding?.length || 0} (expected ${EMBEDDING_DIM})`;
        console.log(`[job ${job.id}] ❌ ${err}`);
        return {
          success: false,
          error: err,
          data: { memoryId, success: false, error: "invalid_dimension" },
        };
      }
      
      await job.updateProgress({ stage: "storing", percent: 80 });
      
      // Update database
      await updateEmbedding(memoryId, embedding);
      
      await job.updateProgress({ stage: "completed", percent: 100 });
      
      console.log(`[job ${job.id}] ✅ Completed`);
      return {
        success: true,
        data: { memoryId, success: true, embeddingDim: embedding.length },
      };
      
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[job ${job.id}] ❌ Error: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        data: { memoryId, success: false, error: errorMsg },
      };
    }
  }
);

// Start worker
await worker.start();
console.log("\n✅ Worker started. Press Ctrl+C to stop.\n");

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n📛 Received ${signal}, shutting down gracefully...`);
  
  try {
    await worker.shutdown(30000); // 30s timeout
    console.log("✅ Worker shutdown complete");
  } catch (e) {
    console.error("❌ Error during shutdown:", e);
  }
  
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
