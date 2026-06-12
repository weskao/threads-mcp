#!/usr/bin/env node
/**
 * Cross-platform process inspector for threads-mcp-server.
 *
 * Subcommands:
 *   node scripts/ps.js check       — list every running threads-mcp process
 *   node scripts/ps.js kill-stale  — kill stdio instances, spare the --http resident
 *
 * Platform implementations:
 *   Unix (darwin/linux): ps -axo pid,ppid,rss,args  (args = full argv string, POSIX XSI)
 *   Windows (win32):     PowerShell Get-CimInstance Win32_Process → JSON
 *
 * Both paths return a uniform array of { pid, ppid, rssKB, isHttp, cmd }.
 */
import { spawnSync } from 'child_process';

// The marker that identifies a threads-mcp server process.
// Safety: ps.js lives at scripts/ps.js — its own Node process command line
// will never contain this string, so the MARKER filter naturally excludes it.
// An explicit pid === process.pid guard is also applied inside each platform
// function for defence-in-depth.
const MARKER = 'threads-mcp/dist/index.js';

// ---------------------------------------------------------------------------
// Process enumeration — per-platform
// ---------------------------------------------------------------------------

/**
 * @typedef {{ pid: number, ppid: number, rssKB: number, isHttp: boolean, cmd: string }} ProcInfo
 */

/**
 * Enumerate processes on Unix (macOS / Linux) using `ps`.
 *
 * Output columns: pid ppid rss args
 * We use "args" (POSIX standard for "full command line with arguments").
 * On Linux, "command" returns only the executable basename; "args" returns
 * the full argv string on both macOS (BSD ps) and Linux (procps).
 * rss is reported in KB by ps on both platforms (POSIX convention).
 *
 * @returns {ProcInfo[]}
 */
function listProcessesUnix() {
  // -a: all users  -x: include processes without a tty  -o: custom format
  // We use spawnSync to avoid shell injection — arguments are passed as an
  // array, never interpolated into a shell string.
  const result = spawnSync('ps', ['-axo', 'pid,ppid,rss,args'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });

  if (result.signal) {
    throw new Error(`ps timed out (signal: ${result.signal})`);
  }
  if (result.error) {
    throw new Error(`ps failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ps exited ${result.status}: ${result.stderr.trim()}`);
  }

  const lines = result.stdout.split('\n');
  /** @type {ProcInfo[]} */
  const procs = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match lines that contain our marker string.
    if (!trimmed.includes(MARKER)) continue;

    // Parse: PID PPID RSS <rest of command — may contain spaces>
    // Use a regex that grabs the first three numeric fields, then the rest.
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;

    const pid = parseInt(m[1], 10);
    // Explicit self-exclusion: skip our own ps.js node process. Naturally
    // safe since ps.js isn't dist/index.js, but defensive guard is clearer.
    if (pid === process.pid) continue;
    const ppid = parseInt(m[2], 10);
    const rssKB = parseInt(m[3], 10);
    const cmd = m[4].trim();

    procs.push({ pid, ppid, rssKB, isHttp: cmd.includes('--http'), cmd });
  }

  return procs;
}

/**
 * Enumerate processes on Windows using PowerShell CIM.
 *
 * WorkingSetSize is in bytes; we convert to KB to match Unix RSS parity.
 *
 * @returns {ProcInfo[]}
 */
function listProcessesWindows() {
  // Build a self-contained PowerShell one-liner. We pass the marker via an
  // environment variable to avoid any quoting / injection issues in the
  // -Command string.
  // We try 'pwsh' (PowerShell 7+) first and fall back to 'powershell' (5.x)
  // for compatibility across Windows versions.
  const psCommand = [
    "Get-CimInstance Win32_Process",
    "| Where-Object { $_.CommandLine -like $env:PROC_MARKER }",
    "| Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine",
    "| ConvertTo-Json -Depth 2",
  ].join(' ');

  const spawnOpts = {
    encoding: /** @type {'utf8'} */ ('utf8'),
    stdio: /** @type {['ignore','pipe','pipe']} */ (['ignore', 'pipe', 'pipe']),
    timeout: 15_000,
    env: {
      ...process.env,
      // Wildcard pattern for the -like operator — no shell quoting risk.
      PROC_MARKER: `*${MARKER}*`,
    },
  };

  // Try pwsh (PowerShell 7+) first; fall back to powershell (5.x).
  let result = spawnSync('pwsh', ['-NoProfile', '-Command', psCommand], spawnOpts);
  if (result.error && /** @type {any} */ (result.error).code === 'ENOENT') {
    result = spawnSync('powershell', ['-NoProfile', '-Command', psCommand], spawnOpts);
  }

  if (result.signal) {
    throw new Error(`powershell timed out (signal: ${result.signal})`);
  }
  if (result.error) {
    throw new Error(`powershell failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`powershell exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`);
  }

  const raw = result.stdout.trim();
  if (!raw) return [];

  /** @type {object | object[]} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse powershell JSON output: ${raw.slice(0, 500)}`);
  }

  // ConvertTo-Json returns a single object (not array) when there is exactly one match.
  const items = Array.isArray(parsed) ? parsed : [parsed];

  const selfPid = process.pid;
  /** @type {ProcInfo[]} */
  const procs = [];
  for (const item of items) {
    const cmd = (item.CommandLine ?? '').toString();
    const pid = Number(item.ProcessId);
    // Explicit self-exclusion guard.
    if (pid === selfPid) continue;
    const ppid = Number(item.ParentProcessId);
    // WorkingSetSize is serialised as a JSON number (bytes) → convert to KB.
    const rssKB = Math.round(Number(item.WorkingSetSize ?? 0) / 1024);
    procs.push({ pid, ppid, rssKB, isHttp: cmd.includes('--http'), cmd });
  }
  return procs;
}

/**
 * Platform-dispatched enumeration. Returns a uniform array.
 *
 * @returns {ProcInfo[]}
 */
function listProcesses() {
  if (process.platform === 'win32') {
    return listProcessesWindows();
  }
  // darwin, linux, and any other Unix-like system
  return listProcessesUnix();
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * `check` — print a table of all threads-mcp processes.
 */
function cmdCheck() {
  const procs = listProcesses();

  if (procs.length === 0) {
    console.log('(none)');
    return;
  }

  // Header
  console.log(
    ['PID'.padStart(7), 'PPID'.padStart(7), 'RSS(KB)'.padStart(9), 'TYPE'.padEnd(8), 'COMMAND'].join('  ')
  );
  console.log('-'.repeat(80));

  for (const p of procs) {
    const type = p.isHttp ? 'http' : 'stdio';
    console.log(
      [
        String(p.pid).padStart(7),
        String(p.ppid).padStart(7),
        String(p.rssKB).padStart(9),
        type.padEnd(8),
        p.cmd,
      ].join('  ')
    );
  }
}

/**
 * `kill-stale` — kill stdio instances only; spare --http resident.
 */
function cmdKillStale() {
  const procs = listProcesses();
  const stale = procs.filter((p) => !p.isHttp);

  if (stale.length === 0) {
    console.log('No stale stdio instances found.');
    return;
  }

  const killed = [];
  const failed = [];

  for (const p of stale) {
    try {
      if (process.platform === 'win32') {
        // On Windows use taskkill for reliable termination of non-child processes.
        const r = spawnSync('taskkill', ['/PID', String(p.pid), '/F'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        });
        if (r.status !== 0) {
          throw new Error(r.stderr.trim() || `taskkill exited ${r.status}`);
        }
      } else {
        process.kill(p.pid, 'SIGTERM');
      }
      killed.push(p.pid);
    } catch (/** @type {any} */ err) {
      failed.push({ pid: p.pid, reason: err.message });
    }
  }

  if (killed.length > 0) {
    console.log(`Killed stdio instance(s): ${killed.join(', ')}`);
  }
  if (failed.length > 0) {
    for (const f of failed) {
      console.error(`Failed to kill PID ${f.pid}: ${f.reason}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

switch (subcommand) {
  case 'check':
    cmdCheck();
    break;

  case 'kill-stale':
    cmdKillStale();
    break;

  default:
    console.error(`Usage: node scripts/ps.js <check|kill-stale>`);
    console.error('');
    console.error('  check       List all running threads-mcp processes (PID, PPID, RSS, type)');
    console.error('  kill-stale  Kill stdio instances; spare the --http resident process');
    process.exit(1);
}
