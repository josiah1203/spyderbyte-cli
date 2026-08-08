import process from 'node:process';
import { runLocalDaemonServer } from './server.js';

runLocalDaemonServer().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
