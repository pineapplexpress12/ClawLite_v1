import type { FastifyInstance } from 'fastify';
import { getArtifact } from '../db/artifacts.js';
import type { ArtifactRow } from '../db/artifacts.js';

/**
 * Render an artifact as a simple HTML page.
 */
function renderArtifactAsHTML(artifact: ArtifactRow): string {
  const escaped = (artifact.content ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${artifact.title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
    pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; }
    .meta { color: #666; font-size: 0.85rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <h1>${artifact.title}</h1>
  <div class="meta">Type: ${artifact.type} | Created: ${new Date(artifact.created_at).toISOString()}</div>
  <pre>${escaped}</pre>
</body>
</html>`;
}

/**
 * Register artifact viewer routes.
 * GET /artifacts/:id
 */
export function registerArtifactRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>('/artifacts/:id', async (req, reply) => {
    const artifact = getArtifact(req.params.id);
    if (!artifact) {
      return reply.status(404).send('Not found');
    }

    // If artifact is HTML, serve directly
    if (artifact.type === 'html') {
      return reply.type('text/html').send(artifact.content ?? '');
    }

    // Render other types as HTML
    return reply.type('text/html').send(renderArtifactAsHTML(artifact));
  });
}
