/**
 * Frontend base — arquivo único self-contained, estilo do Álvaro
 * (docs/08: dark exclusivo; preferência: arquivo único, estilo em objetos).
 * F0: shell mínimo que consome /api/summary e /api/health.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url));

export function registerStatic(app: FastifyInstance): void {
  // SPA mínima servida inline na F0 — sem bundler ainda (base enxuta).
  const indexPath = join(WEB_DIR, 'index.html');
  const hasShell = existsSync(indexPath);
  app.setNotFoundHandler(async (req, reply) => {
    if (req.raw.url?.startsWith('/api')) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    if (!hasShell) {
      return reply.code(503).send({ error: 'WEB_NOT_BUILT' });
    }
    reply.type('text/html').send(readFileSync(indexPath));
  });
}

// Nota: createServer importado só para tipar o handler estático futuro.
void createServer;
