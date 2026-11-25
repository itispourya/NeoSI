import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { agentRuntime } from './src/server/agent/runtime.ts';
import { env } from './src/server/config/env.ts';
import { getDb } from './src/server/db/adapter.ts';
import { knowledgeDaemon } from './src/server/knowledge/daemon.ts';
import { registerReflectionWorker } from './src/server/knowledge/reflection.ts';
import { adminRouter } from './src/server/routes/admin.ts';
import { coreRouter } from './src/server/routes/core.ts';
import { evolutionRouter } from './src/server/routes/evolution.ts';
import { forgeRouter } from './src/server/routes/forge.ts';
import { knowledgeRouter } from './src/server/routes/knowledge.ts';
import { memoryRouter } from './src/server/routes/memory.ts';
import { modelsRouter } from './src/server/routes/models.ts';
import { systemRouter } from './src/server/routes/system.ts';
import { tasksRouter } from './src/server/routes/tasks.ts';
import { toolsRouter } from './src/server/routes/tools.ts';
import { autonomousScheduler } from './src/server/scheduler/autonomousScheduler.ts';
import { securityHeadersAndTracingMiddleware, structuredErrorHandler } from './src/server/security/headers.ts';
import { toolRegistry } from './src/server/tools/registry.ts';

async function startServer() {
  // Initialize database, built-in tool registry, recovery, and autonomous daemons
  await getDb();
  await toolRegistry.syncBuiltInToolsToDb();
  const recoveredCount = await agentRuntime.recoverInterruptedTasks();
  if (recoveredCount > 0) {
    console.log(`[Neo Runtime] Recovered ${recoveredCount} interrupted autonomous task(s) from database.`);
  }
  registerReflectionWorker();
  knowledgeDaemon.start();
  autonomousScheduler.start();

  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeadersAndTracingMiddleware);
  app.use(express.json({ limit: '4mb' }));

  // Mount Neo Cognitive Gateway & Admin Control Plane
  app.use('/api/v1', systemRouter);
  app.use('/api/v1', coreRouter);
  app.use('/api/v1', tasksRouter);
  app.use('/api/v1', memoryRouter);
  app.use('/api/v1', knowledgeRouter);
  app.use('/api/v1', toolsRouter);
  app.use('/api/v1', modelsRouter);
  app.use('/api/v1', evolutionRouter);
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

  app.use(structuredErrorHandler);

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`[Neo] Sovereign Cognitive OS & API Forge listening on http://0.0.0.0:${env.port}`);
  });
}

startServer().catch((err) => {
  console.error('[Neo] Fatal startup error:', err);
  process.exit(1);
});
