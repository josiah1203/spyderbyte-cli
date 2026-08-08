import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const frontendRoot = resolve(process.env.AGENTIC_FRONTEND_ROOT ?? resolve(root, 'apps/web'));
const frontendDist = resolve(frontendRoot, 'dist');
const desktopDist = resolve(root, 'apps/desktop/frontend-dist');

execFileSync('pnpm', ['--dir', frontendRoot, 'build'], { cwd: root, stdio: 'inherit' });
rmSync(desktopDist, { recursive: true, force: true });
mkdirSync(desktopDist, { recursive: true });
cpSync(frontendDist, desktopDist, { recursive: true });
console.log(`Copied React frontend artifact to ${desktopDist}`);
