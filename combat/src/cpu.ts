/**
 * Leave the first core to the player: the batch tools pin themselves to
 * every core but core 0 and run below normal priority, and the processes and
 * worker threads they start inherit both (Windows passes the affinity mask
 * and the priority class to a child). The project owner plays while a run
 * simulates (2026-09-28).
 *
 * RTMR_ALL_CORES=1 in the environment turns it off. Linux gets the priority
 * only (no affinity without taskset); nothing fails if either call does.
 */
import { spawnSync } from 'node:child_process';
import { availableParallelism, constants, setPriority } from 'node:os';

let done = false;

/** The cores left for the run: all but the first. */
export const workCores = () => (process.env.RTMR_ALL_CORES === '1' ? availableParallelism() : Math.max(1, availableParallelism() - 1));

export function leaveFirstCore(): void {
  if (done || process.env.RTMR_ALL_CORES === '1') return;
  done = true;
  try { setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed: carry on */ }
  const n = availableParallelism();
  if (process.platform !== 'win32' || n < 2) return;
  // Cores 1..n-1: every bit but the lowest. Past 62 cores the mask would not fit a JS number safely.
  const mask = n >= 63 ? null : (2 ** n - 1) - 1;
  if (mask === null) return;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`], { stdio: 'ignore', windowsHide: true });
}
