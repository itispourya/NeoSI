import fs from 'node:fs';
import path from 'node:path';

export interface FileSymbolEntry {
  file: string;
  lines: number;
  exports: string[];
  imports: string[];
}

export interface RepoMap {
  totalFiles: number;
  totalLines: number;
  files: FileSymbolEntry[];
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.neo-worktrees', '.playwright-cli', 'data']);

export function indexWorkspaceCodebase(rootDir = path.resolve(process.cwd(), 'src')): RepoMap {
  const files: FileSymbolEntry[] = [];
  let totalLines = 0;

  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').length;
        totalLines += lines;

        const exports: string[] = [];
        const exportMatches = content.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g);
        for (const m of exportMatches) exports.push(m[1]);

        const imports: string[] = [];
        const importMatches = content.matchAll(/from\s+['"]([^'"]+)['"]/g);
        for (const m of importMatches) imports.push(m[1]);

        files.push({
          file: path.relative(process.cwd(), fullPath).replace(/\\/g, '/'),
          lines,
          exports,
          imports,
        });
      }
    }
  }

  walk(rootDir);
  return { totalFiles: files.length, totalLines, files };
}
