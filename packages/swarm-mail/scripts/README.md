# Scripts

Utility scripts for swarm-mail operations.

## Embedding Backfill (Queue-based)

Queue-based embedding backfill using BullMQ for reliable, observable job processing.

### Scripts

| Script | Description |
|--------|-------------|
| `backfill-status.ts` | Check backfill progress (DB + queue status) |
| `backfill-submit.ts` | Submit memories to the queue for processing |
| `backfill-worker.ts` | Worker that processes embedding jobs |

### Quick Start

```bash
cd packages/swarm-mail

# 1. Check current status
bun run scripts/backfill-status.ts

# 2. Submit jobs (dry-run first to verify)
bun run scripts/backfill-submit.ts --dry-run --limit=100
bun run scripts/backfill-submit.ts --limit=1000

# 3. Start worker(s)
bun run scripts/backfill-worker.ts --concurrency=2

# 4. Monitor progress
bun run scripts/backfill-status.ts --verbose
```

### Features

- **Idempotent submission**: Re-running submit script skips already-queued jobs
- **Exponential backoff**: Automatic retry with 2s → 4s → 8s delays on Ollama errors
- **Progress visibility**: Check status via `backfill-status.ts` or `queue_status` MCP tool
- **Graceful shutdown**: Workers complete in-progress jobs before exiting
- **Concurrency control**: Configure parallel job processing

### Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_HOST` | `localhost` | Redis server host |
| `REDIS_PORT` | `6379` | Redis server port |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `mxbai-embed-large` | Embedding model |

### CLI Options

**backfill-submit.ts:**
- `--dry-run` - Preview without submitting
- `--limit=N` - Limit number of jobs to submit
- `--batch=N` - Batch size for submission (default: 100)

**backfill-worker.ts:**
- `--concurrency=N` - Number of parallel jobs (default: 2)

**backfill-status.ts:**
- `--verbose` - Show failed job details

### Queue Operations (via MCP)

```bash
# List jobs
queue_list --queue_name hivemind-backfill --state waiting

# Check specific job
queue_status --job_id embed-mem-xxx

# Cancel all waiting jobs
queue_cancel --job_id <id>
```

---

## Legacy Backfill

The original inline script (non-queue):

```bash
bun run scripts/backfill-embeddings.ts [--dry-run] [--batch-size=100] [--limit=1000]
```

This processes embeddings inline without queue visibility. Use the queue-based scripts above for better observability.
