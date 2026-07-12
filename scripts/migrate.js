#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const pg = require("pg");

async function main() {
  const connectionString = process.env.AGENTBAR_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("AGENTBAR_DATABASE_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const directory = path.join(__dirname, "..", "db", "migrations");
    const migrations = (await fs.readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    for (const file of migrations) await client.query(await fs.readFile(path.join(directory, file), "utf8"));
    console.log(`Applied ${migrations.length} AgentBar migrations.`);
  } finally {
    await client.end();
  }
}
main().catch((error) => { console.error(error.message); process.exit(1); });
