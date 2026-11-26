import { env } from '../config/env.ts';
import type { NeoDatabase } from './interface.ts';
import { PostgresNeoDatabase } from './postgres.ts';
import { SqliteNeoDatabase } from './sqlite.ts';

export type { MemoryCounts, MemoryQueryOptions, MemorySearchOptions, MemorySearchResult, NeoDatabase } from './interface.ts';

let dbInstance: NeoDatabase | null = null;
let initPromise: Promise<NeoDatabase> | null = null;

export async function getDb(): Promise<NeoDatabase> {
  if (dbInstance) return dbInstance;
  if (!initPromise) {
    const pending = (async () => {
      const instance: NeoDatabase = env.databaseUrl
        ? new PostgresNeoDatabase(env.databaseUrl)
        : new SqliteNeoDatabase(env.sqliteDbPath);
      await instance.init();
      dbInstance = instance;
      return instance;
    })();
    initPromise = pending;
    // Retry after transient init errors instead of permanently caching a rejected promise.
    void pending.catch(() => {
      if (initPromise === pending) initPromise = null;
    });
  }
  return initPromise;
}

export async function resetDbForTests(customSqlitePath?: string): Promise<NeoDatabase> {
  if (dbInstance?.close) {
    await dbInstance.close();
  }
  dbInstance = null;
  initPromise = null;
  if (customSqlitePath) {
    const instance = new SqliteNeoDatabase(customSqlitePath);
    await instance.init();
    dbInstance = instance;
    return instance;
  }
  return getDb();
}
