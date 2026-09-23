#!/usr/bin/env node
/**
 * Generate .env for the five campus MCP services from their .env.example.
 *
 * The .env files are gitignored, so a fresh clone on a new machine has none.
 * The services self-heal on first start (they copy .env.example -> .env when
 * missing), and this script does the same thing for all five at once without
 * starting any server — handy before first run or for CLI debugging.
 *
 * Usage:
 *   node scripts/setup-campus-env.mjs                 # create missing .env files
 *   node scripts/setup-campus-env.mjs --key sk-xxxx   # also write the DashScope key
 *
 * The key value is never echoed back.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CAMPUS_SERVICES = [
  'contract-guard',
  'course-path-server',
  'policy-comparison',
  'policy-search',
  'rag-mcp-server',
];

const PLACEHOLDER_TOKENS = [/your_api_key_here/g, /your_dashscope_api_key/g];

const log = (...args) => console.log('[setup-campus-env]', ...args);
const warn = (...args) => console.warn('[setup-campus-env]', ...args);

function parseArgs(argv) {
  const args = { key: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--key') {
      args.key = (argv[i + 1] || '').trim();
      i += 1;
    } else if (token.startsWith('--key=')) {
      args.key = token.slice('--key='.length).trim();
    } else if (token === '--help' || token === '-h') {
      console.log('usage: node scripts/setup-campus-env.mjs [--key <DASHSCOPE_API_KEY>]');
      process.exit(0);
    } else {
      warn(`ignoring unknown argument: ${token}`);
    }
  }
  return args;
}

function stripPlaceholders(text) {
  return PLACEHOLDER_TOKENS.reduce((acc, pattern) => acc.replace(pattern, ''), text);
}

function upsertDashscopeKey(text, key) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const keyLine = `DASHSCOPE_API_KEY=${key}`;
  const index = lines.findIndex((line) => /^\s*DASHSCOPE_API_KEY\s*=/.test(line));
  if (index >= 0) {
    lines[index] = keyLine;
  } else if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.splice(lines.length - 1, 0, keyLine);
  } else {
    lines.push(keyLine);
  }
  return lines.join(eol);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.argv.includes('--key') && !args.key) {
    warn('--key requires a value, e.g. --key sk-xxxx');
    process.exit(1);
  }
  if (args.key.includes('your_')) {
    warn('the provided key looks like a placeholder, refusing to write it');
    process.exit(1);
  }

  const created = [];
  const kept = [];
  const failed = [];

  for (const service of CAMPUS_SERVICES) {
    const dir = path.join(REPO_ROOT, service);
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');

    if (!fs.existsSync(examplePath)) {
      failed.push(`${service} (missing .env.example)`);
      continue;
    }

    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, stripPlaceholders(fs.readFileSync(examplePath, 'utf8')), 'utf8');
      created.push(service);
    } else {
      kept.push(service);
    }

    if (args.key) {
      const current = fs.readFileSync(envPath, 'utf8');
      const next = upsertDashscopeKey(current, args.key);
      if (next !== current) {
        fs.writeFileSync(envPath, next, 'utf8');
      }
    }
  }

  if (created.length > 0) log(`created .env from .env.example: ${created.join(', ')}`);
  if (kept.length > 0) log(`kept existing .env (not overwritten): ${kept.join(', ')}`);
  if (args.key) log('DASHSCOPE_API_KEY written to all available .env files (value not echoed)');
  for (const item of failed) warn(`skipped: ${item}`);

  if (created.length === 0 && kept.length === 0) {
    warn('nothing to do — no campus service found next to this script');
    process.exit(1);
  }

  log('done. The app also injects the key at runtime; edit .env only for CLI debugging.');
}

main();
