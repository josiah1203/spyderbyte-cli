import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const frontendRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const port = parseInt(process.env.PORT ?? '8443', 10);

  return {
    appType: 'spa',
    base: '/',
    build: {
      sourcemap: mode === 'development' ? 'inline' : false,
      minify: mode !== 'development',
    },
    plugins: [react(), tailwindcss(), managedRuntimeProxy()],
    resolve: {
      alias: {
        '@': path.resolve(frontendRoot, 'src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      watch: { ignored: ['**/.turbo/**', '**/dist/**'] },
    },
    preview: {
      host: '0.0.0.0',
      port,
    },
  };
});

/** Starts the local daemon for browser development and proxies /v1 server-side. */
function managedRuntimeProxy(): Plugin {
  return {
    name: 'managed-agentic-runtime',
    configureServer(server) {
      if (
        process.env.AGENTIC_MANAGED_RUNTIME === 'false' ||
        process.env.VITE_AGENTIC_RUNTIME_MODE === 'mock'
      ) {
        return;
      }

      const augRoot = process.env.AGENTIC_ROOT ?? path.resolve(frontendRoot, '../..');
      const workspace =
        process.env.AGENTIC_WORKSPACE ?? path.resolve(augRoot, '.agentic-workspace');
      const authToken = randomBytes(32).toString('base64url');
      let target: { baseUrl: string; authToken?: string } | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let lines: ReturnType<typeof createInterface> | undefined;

      try {
        child = spawn(
          process.env.npm_execpath ?? 'pnpm',
          ['--dir', augRoot, '--filter', '@agentic-platform/local-daemon', 'local:server'],
          {
            env: {
              ...process.env,
              AGENTIC_WORKSPACE: workspace,
              AGENTIC_LOCAL_API_HOST: '127.0.0.1',
              AGENTIC_LOCAL_API_PORT: '0',
              AGENTIC_LOCAL_API_AUTH_REQUIRED: 'true',
              AGENTIC_LOCAL_API_TOKEN: authToken,
            },
            stdio: 'pipe',
          },
        );
      } catch (error) {
        server.config.logger.error(`Unable to start managed runtime: ${String(error)}`);
      }

      if (child) {
        lines = createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          try {
            const parsed = JSON.parse(line) as {
              ready?: boolean;
              address?: string;
              authToken?: string;
            };
            if (parsed.ready === true && parsed.address) {
              target = {
                baseUrl: parsed.address,
                ...(parsed.authToken ? { authToken: parsed.authToken } : {}),
              };
            }
          } catch {
            // Daemon logs are intentionally not forwarded into browser responses.
          }
        });
        child.stderr.on('data', (chunk) => {
          server.config.logger.info(`[managed runtime] ${String(chunk).trim()}`);
        });
        child.once('exit', () => {
          target = undefined;
        });
      }

      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/v1')) {
          next();
          return;
        }
        if (!target) {
          response.statusCode = 503;
          response.setHeader('content-type', 'application/json; charset=utf-8');
          response.end(JSON.stringify({ error: 'managed_runtime_starting' }));
          return;
        }

        const upstream = new URL(request.url, target.baseUrl);
        const headers = {
          ...request.headers,
          host: upstream.host,
          ...(target.authToken ? { authorization: `Bearer ${target.authToken}` } : {}),
        };
        delete headers.connection;

        const proxy = httpRequest(
          upstream,
          { method: request.method, headers },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          },
        );
        proxy.on('error', (error) => {
          if (!response.headersSent) {
            response.statusCode = 502;
            response.setHeader('content-type', 'application/json; charset=utf-8');
            response.end(
              JSON.stringify({
                error: 'managed_runtime_proxy_error',
                detail: String(error),
              }),
            );
          } else {
            response.end();
          }
        });
        request.pipe(proxy);
      });

      server.httpServer?.once('close', () => {
        lines?.close();
        if (child && !child.killed) child.kill('SIGTERM');
      });
    },
  };
}
