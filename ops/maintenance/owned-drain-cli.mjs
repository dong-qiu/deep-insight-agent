/** Offline fixed isolated entry. Never imports credentials or a cloud transport. */
import { runOwnedDrainCli } from './owned-drain.mjs';
try { await runOwnedDrainCli(); }
catch(error) {
  const code=error instanceof Error&&/^[A-Za-z0-9_-]{1,128}$/.test(error.message)?error.message:'owned_drain_failed';
  process.stderr.write(code+'\n');process.exitCode=1;
}
