#!/usr/bin/env node
/**
 * Cross-platform Claude MCP registration helper for the Threads MCP server.
 *
 * Subcommands:
 *   check      — show current `claude mcp get threads` output (or friendly
 *                "not registered" message if threads is absent / claude not found)
 *   use-http   — register threads via Streamable HTTP at http://127.0.0.1:8307/mcp
 *   use-stdio  — register threads via stdio, pointing at this project's dist/index.js
 *
 * Windows note: spawnSync / execFileSync with shell:false cannot locate .cmd
 * executables (the `claude` CLI ships as `claude.cmd` on Windows). We therefore
 * use `shell: true` throughout. All arguments are compile-time constants or paths
 * derived from import.meta.url — no user-supplied data is ever interpolated into
 * the shell command string, so shell:true is safe here.
 *
 * Usage:
 *   node scripts/mcp-config.js check
 *   node scripts/mcp-config.js use-http
 *   node scripts/mcp-config.js use-stdio
 */
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Portable path resolution — no hardcoded /Users/... anywhere
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');

const HTTP_URL = 'http://127.0.0.1:8307/mcp';
const MCP_NAME = 'threads';

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

/**
 * Run `claude <args>` via the shell so that `claude.cmd` is found on Windows.
 * Returns the SpawnSyncReturns object — caller decides what to do with status.
 *
 * shell:true is safe here: every element in `args` is a compile-time constant
 * or a self-derived absolute path; no untrusted input is ever interpolated.
 */
function runClaude(args, opts = {}) {
  return spawnSync('claude', args, {
    shell: true,
    encoding: 'utf8',
    ...opts,
  });
}

/**
 * Run `claude <args>`, tolerating failure (e.g. "threads not registered yet").
 * Returns true on success, false on any error.
 */
function runClaudeSilent(args) {
  const result = runClaude(args, { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Run `claude <args>`, treating non-zero exit as fatal.
 * Prints stderr and exits the process on failure.
 */
function runClaudeFatal(args) {
  const result = runClaude(args, { stdio: 'inherit' });
  if (result.error) {
    // e.g. ENOENT — claude not on PATH
    console.error(`\nError: could not launch claude CLI — ${result.error.message}`);
    console.error('Make sure the Claude Code CLI is installed and on your PATH.');
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: check
// ---------------------------------------------------------------------------
function cmdCheck() {
  const result = runClaude(['mcp', 'get', MCP_NAME], { stdio: 'pipe' });
  if (result.error || result.status !== 0) {
    // claude not found, or threads not registered
    console.log(`(threads not yet registered with Claude)`);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: use-http
// ---------------------------------------------------------------------------
function cmdUseHttp() {
  console.log(`Removing existing '${MCP_NAME}' MCP registration (if any)...`);
  runClaudeSilent(['mcp', 'remove', MCP_NAME, '-s', 'user']);

  console.log(`Registering '${MCP_NAME}' via HTTP at ${HTTP_URL} ...`);
  // Exact argv passed to claude:
  //   mcp add --transport http --scope user threads http://127.0.0.1:8307/mcp
  runClaudeFatal(['mcp', 'add', '--transport', 'http', '--scope', 'user', MCP_NAME, HTTP_URL]);

  console.log(`\nSuccess. Registered '${MCP_NAME}' as HTTP MCP server at ${HTTP_URL}`);
  console.log('Restart Claude Code to apply the change.');
}

// ---------------------------------------------------------------------------
// Subcommand: use-stdio
// ---------------------------------------------------------------------------
function cmdUseStdio() {
  console.log(`Removing existing '${MCP_NAME}' MCP registration (if any)...`);
  runClaudeSilent(['mcp', 'remove', '--scope', 'user', MCP_NAME]);

  console.log(`Registering '${MCP_NAME}' via stdio at ${distEntry} ...`);
  // Exact argv passed to claude:
  //   mcp add --scope user threads node -- <abs-dist-path> --stdio
  //
  // The `--` separator is required so that claude passes `<path>` to node as a
  // positional argument rather than treating it as a claude flag. The trailing
  // `--stdio` is required because the server defaults to HTTP — without it the
  // registered "stdio" entry would boot an HTTP server the client can't speak to.
  runClaudeFatal(['mcp', 'add', '--scope', 'user', MCP_NAME, 'node', '--', distEntry, '--stdio']);

  console.log(`\nSuccess. Registered '${MCP_NAME}' as stdio MCP server.`);
  console.log(`  Entry: ${distEntry}`);
  console.log('Restart Claude Code to apply the change.');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const subcommand = process.argv[2];

switch (subcommand) {
  case 'check':
    cmdCheck();
    break;
  case 'use-http':
    cmdUseHttp();
    break;
  case 'use-stdio':
    cmdUseStdio();
    break;
  default:
    console.error(
      `Usage: node scripts/mcp-config.js <check|use-http|use-stdio>\n` +
        `\n` +
        `  check      Show current Claude MCP registration for '${MCP_NAME}'\n` +
        `  use-http   Register via Streamable HTTP at ${HTTP_URL}\n` +
        `  use-stdio  Register via stdio using ${distEntry}\n`
    );
    process.exit(1);
}
