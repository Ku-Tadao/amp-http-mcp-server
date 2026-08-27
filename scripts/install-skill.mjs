#!/usr/bin/env node
// Copies the bundled skills into the user's Claude skills directory.
//
// Deliberately a command someone runs, not a postinstall hook: installing this
// package should not silently write into ~/.claude, and a skill that appears
// without being asked for is a surprise even when it is a useful one.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "skills");
const target = process.env.CLAUDE_SKILLS_DIR ?? path.join(homedir(), ".claude", "skills");
const force = process.argv.includes("--force");

if (!existsSync(source)) {
  console.error(`No skills directory at ${source}.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

let installed = 0;
let skipped = 0;
for (const name of readdirSync(source, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const destination = path.join(target, name.name);
  if (existsSync(destination) && !force) {
    console.log(`skipped  ${name.name} (already at ${destination}; re-run with --force to overwrite)`);
    skipped += 1;
    continue;
  }
  cpSync(path.join(source, name.name), destination, { recursive: true });
  console.log(`installed ${name.name} -> ${destination}`);
  installed += 1;
}

console.log(`\n${installed} installed, ${skipped} skipped. Restart Claude Code to pick up new skills.`);
