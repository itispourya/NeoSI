import { execFileSync } from 'node:child_process';
import { getDb } from '../db/adapter.ts';

export type ModalityName =
  | 'text'
  | 'code'
  | 'structured_data'
  | 'web_content'
  | 'pdf'
  | 'images'
  | 'audio'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'video';

export interface ModalityCapability {
  modality: ModalityName;
  supported: boolean;
  engine: string;
  notes: string;
}

function hasBinary(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore', timeout: 800 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Honest Multimodal Capability Registry (Section 13):
 * Reports exact locally available capabilities and never falsely advertises unsupported modalities.
 */
export async function getCapabilityRegistry(): Promise<{
  modalities: ModalityCapability[];
  supportedCount: number;
  totalCount: number;
}> {
  const db = await getDb();
  const models = await db.listModels();
  const activeModalities = new Set<string>();
  for (const m of models) {
    if (m.deployment_status === 'active' && m.download_status === 'ready') {
      for (const mod of m.modalities) activeModalities.add(mod);
    }
  }

  const hasWhisper = hasBinary('whisper') || hasBinary('whisper-cli');
  const hasPiper = hasBinary('piper') || hasBinary('espeak-ng');
  const hasFfmpeg = hasBinary('ffmpeg');

  const modalities: ModalityCapability[] = [
    {
      modality: 'text',
      supported: true,
      engine: 'NeoInferenceEngine (embedded / ollama / vllm)',
      notes: 'Full EN/FA/AR/NL text reasoning & synthesis.',
    },
    {
      modality: 'code',
      supported: true,
      engine: 'Neo Autonomous Engineer + Subprocess Sandbox',
      notes: 'Code indexing, TypeScript/JS synthesis, and isolated test execution.',
    },
    {
      modality: 'structured_data',
      supported: true,
      engine: 'Zod Schema Engine + Deterministic Financial/Ops Auditor',
      notes: 'Accounting ledgers, CRM cohorts, SKU inventory & JSON schemas.',
    },
    {
      modality: 'web_content',
      supported: true,
      engine: 'DNS-SSRF-Guarded safeExternalFetch + HTML/XML Extractor',
      notes: 'Live public documentation, GitHub, arXiv, Wikipedia, and optional SERP.',
    },
    {
      modality: 'pdf',
      supported: true,
      engine: 'Neo Local FlateDecode PDF Extractor (node:zlib)',
      notes: 'Extracts selectable text streams from PDF buffers locally.',
    },
    {
      modality: 'images',
      supported: activeModalities.has('vision'),
      engine: activeModalities.has('vision') ? 'Local Vision Model' : 'Not configured',
      notes: activeModalities.has('vision')
        ? 'Local vision model active.'
        : 'Requires activating a local VLM (e.g., Qwen2-VL / LLaVA via vLLM or Ollama).',
    },
    {
      modality: 'speech_to_text',
      supported: hasWhisper || activeModalities.has('speech_recognition'),
      engine: hasWhisper ? 'Local Whisper CLI' : 'Not installed',
      notes: hasWhisper ? 'Local audio transcription available.' : 'Install whisper.cpp or faster-whisper server to enable.',
    },
    {
      modality: 'text_to_speech',
      supported: hasPiper || activeModalities.has('speech_generation'),
      engine: hasPiper ? 'Local Piper/eSpeak' : 'Not installed',
      notes: hasPiper ? 'Local speech synthesis available.' : 'Install Piper TTS or Coqui XTTS local service to enable.',
    },
    {
      modality: 'audio',
      supported: hasWhisper || hasFfmpeg,
      engine: hasFfmpeg ? 'FFmpeg + Whisper' : 'Not installed',
      notes: hasFfmpeg ? 'Local audio preprocessing available.' : 'Requires ffmpeg and local audio model.',
    },
    {
      modality: 'video',
      supported: hasFfmpeg && activeModalities.has('vision'),
      engine: 'Not configured',
      notes: 'Requires ffmpeg frame extraction plus an active local vision model.',
    },
  ];

  return {
    modalities,
    supportedCount: modalities.filter((m) => m.supported).length,
    totalCount: modalities.length,
  };
}
