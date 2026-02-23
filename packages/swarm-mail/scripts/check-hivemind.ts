#!/usr/bin/env npx tsx

import { createClient } from "@libsql/client";
import { resolve } from "path";
import { homedir } from "os";

const dbPath = resolve(homedir(), ".config/swarm-tools/swarm.db");
console.log("Database path:", dbPath);

const client = createClient({ url: `file:${dbPath}` });

async function diagnose() {
  // Check total memories
  const total = await client.execute("SELECT COUNT(id) as count FROM memories");
  console.log("\n📊 Total memories:", total.rows[0].count);

  // Check embeddings
  const embeddings = await client.execute("SELECT COUNT(id) as count FROM memories WHERE embedding IS NOT NULL");
  console.log("📊 With embeddings:", embeddings.rows[0].count);

  // Check memories without embeddings (sample)
  const noEmbed = await client.execute("SELECT id, created_at, LENGTH(content) as content_len FROM memories WHERE embedding IS NULL LIMIT 5");
  console.log("\n❌ Sample memories WITHOUT embeddings:");
  for (const row of noEmbed.rows) {
    console.log(`  - ${row.id} (created: ${row.created_at}, content_len: ${row.content_len})`);
  }

  // Check FTS5 table
  const ftsCount = await client.execute("SELECT COUNT(id) as count FROM memories_fts");
  console.log("\n🔍 FTS5 index entries:", ftsCount.rows[0].count);

  // Check triggers
  const triggers = await client.execute(`
    SELECT name FROM sqlite_master 
    WHERE type='trigger' AND name LIKE 'memories_fts%'
  `);
  console.log("\n⚡ FTS triggers found:", triggers.rows.map(r => r.name).join(", ") || "NONE!");

  // Check if we can do FTS search
  try {
    const ftsTest = await client.execute(`
      SELECT m.id, m.content 
      FROM memories_fts fts 
      JOIN memories m ON m.rowid = fts.rowid 
      WHERE fts.content MATCH '"test"' 
      LIMIT 3
    `);
    console.log("\n🔎 FTS search for 'test':", ftsTest.rows.length, "results");
    for (const row of ftsTest.rows) {
      console.log(`  - ${row.id}: ${String(row.content).substring(0, 50)}...`);
    }
  } catch (e: any) {
    console.log("\n🔎 FTS search error:", e.message);
  }

  // Check if vector search works
  try {
    const vecTest = await client.execute(`
      SELECT id FROM memories 
      WHERE embedding IS NOT NULL 
      LIMIT 1
    `);
    if (vecTest.rows.length > 0) {
      console.log("\n🧭 Vector search test - found memory with embedding:", vecTest.rows[0].id);
    }
  } catch (e: any) {
    console.log("\n🧭 Vector search error:", e.message);
  }

  // Check when embeddings were created
  const embeddingDates = await client.execute(`
    SELECT DATE(created_at) as date, COUNT(*) as count 
    FROM memories 
    WHERE embedding IS NOT NULL 
    GROUP BY DATE(created_at) 
    ORDER BY date DESC 
    LIMIT 10
  `);
  console.log("\n📅 Embeddings by date (most recent):");
  for (const row of embeddingDates.rows) {
    console.log(`  ${row.date}: ${row.count} embeddings`);
  }

  // Check when NON-embeddings were created
  const noEmbedDates = await client.execute(`
    SELECT DATE(created_at) as date, COUNT(*) as count 
    FROM memories 
    WHERE embedding IS NULL 
    GROUP BY DATE(created_at) 
    ORDER BY date DESC 
    LIMIT 10
  `);
  console.log("\n📅 NO embeddings by date (most recent):");
  for (const row of noEmbedDates.rows) {
    console.log(`  ${row.date}: ${row.count} missing embeddings`);
  }
}

diagnose().catch(console.error);
