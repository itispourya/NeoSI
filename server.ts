import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { env } from './src/server/config/env.ts';
import { getDb } from './src/server/db/adapter.ts';
import { knowledgeDaemon } from './src/server/knowledge/daemon.ts';
import { registerReflectionWorker } from './src/server/knowledge/reflection.ts';
import { adminRouter } from './src/server/routes/admin.ts';
import { coreRouter } from './src/server/routes/core.ts';
import { forgeRouter } from './src/server/routes/forge.ts';

async function startServer() {
  // Initialize DB & background workers
  await getDb();
  registerReflectionWorker();
  knowledgeDaemon.start();

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  // Mount Neo AI Gateway & Admin Routes
  app.use('/api/v1', coreRouter);
  app.use('/api/v1', forgeRouter);
  app.use('/api/admin', adminRouter);

  if (env.nodeEnv !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`[Neo AI] Brain & API Forge running on http://0.0.0.0:${env.port}`);
  });
}

startServer().catch((err) => {
  console.error('[Neo AI] Fatal startup error:', err);
  process.exit(1);
});
