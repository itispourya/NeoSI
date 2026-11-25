import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HardwareProfile } from './types.ts';

const execFileAsync = promisify(execFile);

let cachedHardware: { at: number; profile: HardwareProfile } | null = null;

export async function inspectHardware(forceRefresh = false): Promise<HardwareProfile> {
  if (!forceRefresh && cachedHardware && Date.now() - cachedHardware.at < 15_000) {
    return cachedHardware.profile;
  }

  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Generic CPU';
  const cpuCores = cpus.length || 1;
  const totalRamGb = Number((os.totalmem() / 1024 ** 3).toFixed(2));
  const freeRamGb = Number((os.freemem() / 1024 ** 3).toFixed(2));

  let diskFreeGb = 0;
  try {
    const stat = fs.statfsSync(process.cwd());
    diskFreeGb = Number(((stat.bavail * stat.bsize) / 1024 ** 3).toFixed(2));
  } catch {
    diskFreeGb = 0;
  }

  const gpus: HardwareProfile['gpus'] = [];
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 1500 }
    );
    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const [idxStr, name, totalMbStr, freeMbStr, utilStr] = line.split(',').map((s) => s.trim());
      gpus.push({
        index: Number(idxStr) || 0,
        name: name || 'NVIDIA GPU',
        totalVramGb: Number(((Number(totalMbStr) || 0) / 1024).toFixed(2)),
        freeVramGb: Number(((Number(freeMbStr) || 0) / 1024).toFixed(2)),
        utilizationPct: Number(utilStr) || 0,
      });
    }
  } catch {
    // No NVIDIA GPU or nvidia-smi unavailable — graceful CPU fallback
  }

  const totalVramGb = Number(gpus.reduce((s, g) => s + g.totalVramGb, 0).toFixed(2));
  const hasGpu = gpus.length > 0 && totalVramGb > 0;
  const recommendedProfile: HardwareProfile['recommendedProfile'] =
    gpus.length >= 2 ? 'multi-gpu' : hasGpu ? 'single-gpu' : 'cpu-development';

  const profile: HardwareProfile = {
    cpuModel,
    cpuCores,
    totalRamGb,
    freeRamGb,
    diskFreeGb,
    gpus,
    totalVramGb,
    hasGpu,
    recommendedProfile,
  };
  cachedHardware = { at: Date.now(), profile };
  return profile;
}
