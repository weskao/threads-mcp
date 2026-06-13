#!/usr/bin/env node
// Cross-platform desktop-notification helper.
//
// Usage: node scripts/notify.js "<message>" ["<title>"] ["<success: true|false>"]
//   success=true  → "success" sound (macOS Glass)
//   success=false → "failure" sound (macOS Basso)
//
// macOS: plays a system sound + shows a Notification Center banner.
// Linux / Windows: no native sound/banner — the message is printed to the
// console instead. Notifications here are a dev convenience, so a missing
// notifier on non-macOS platforms is intentionally a no-op (never fails).
import { spawnSync } from 'node:child_process';

const [, , msgArg, titleArg, successArg] = process.argv;
const msg = msgArg ?? '';
const title = titleArg || 'Notification';
const success = (successArg ?? 'true') !== 'false';

function run(cmd, args) {
  try {
    spawnSync(cmd, args, { stdio: 'ignore' });
  } catch {
    // tool missing or not permitted — non-fatal
  }
}

if (process.platform === 'darwin') {
  const sound = success
    ? '/System/Library/Sounds/Glass.aiff'
    : '/System/Library/Sounds/Basso.aiff';
  run('afplay', [sound]);
  // Escape embedded double quotes so the AppleScript string stays valid.
  const safeMsg = msg.replace(/"/g, '\\"');
  const safeTitle = title.replace(/"/g, '\\"');
  run('osascript', ['-e', `display notification "${safeMsg}" with title "${safeTitle}"`]);
} else {
  // Non-macOS: surface the message on the console (no-op for sound/banner).
  console.log(`[notify] ${title}: ${msg}`);
}
