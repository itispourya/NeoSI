export interface InjectionAnalysis {
  flagged: boolean;
  riskScore: number;
  matches: string[];
  sanitizedText: string;
}

const INJECTION_PATTERNS: Array<{ label: string; regex: RegExp; weight: number }> = [
  {
    label: 'instruction_override',
    regex: /\b(ignore|disregard|forget|override)\s+(all\s+)?(previous|prior|above|system)\s+(instructions|prompts|rules|directives)\b/gi,
    weight: 0.45,
  },
  {
    label: 'role_hijack',
    regex: /\b(you are now|act as|pretend to be|switch to developer mode|jailbreak|dan mode)\b/gi,
    weight: 0.35,
  },
  {
    label: 'secret_exfiltration',
    regex: /\b(reveal|print|dump|exfiltrate|send|output)\s+(the\s+)?(api[_\s]?key|env|process\.env|password|secret|private key|system prompt|admin passcode)\b/gi,
    weight: 0.5,
  },
  {
    label: 'code_exec_lure',
    regex: /\b(execute|run|eval)\s+(this\s+)?(shell|bash|curl|wget|powershell|rm\s+-rf|child_process)\b/gi,
    weight: 0.4,
  },
  {
    label: 'hidden_markup_directive',
    regex: /<!--[\s\S]*?(system|instruction|ignore previous|execute)[\s\S]*?-->|<\/?(?:system|assistant|tool_call)>/gi,
    weight: 0.35,
  },
];

/**
 * Inspect external/untrusted content for prompt injection payloads and neutralize control directives.
 */
export function detectPromptInjection(rawText: string): InjectionAnalysis {
  const input = String(rawText || '');
  const matches: string[] = [];
  let riskScore = 0;

  let sanitized = input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E]/g, '')
    .replace(/<\/?(?:system|assistant|tool_call|instructions?)>/gi, '[TAG_STRIPPED]');

  for (const rule of INJECTION_PATTERNS) {
    if (rule.regex.test(sanitized)) {
      matches.push(rule.label);
      riskScore += rule.weight;
      sanitized = sanitized.replace(rule.regex, '[UNTRUSTED_DIRECTIVE_NEUTRALIZED]');
    }
    rule.regex.lastIndex = 0;
  }

  return {
    flagged: matches.length > 0 || riskScore >= 0.35,
    riskScore: Number(Math.min(1, riskScore).toFixed(2)),
    matches,
    sanitizedText: sanitized.trim(),
  };
}

export function sanitizeUntrustedContent(rawText: string, sourceLabel = 'external_source'): {
  cleanText: string;
  flagged: boolean;
  matches: string[];
  wrappedData: string;
} {
  const analysis = detectPromptInjection(rawText);
  const safeLabel = sourceLabel.replace(/[^a-zA-Z0-9._:/-]/g, '_').slice(0, 120);
  // Escape markup from the source so it cannot close or forge our trust-boundary tags.
  const escapedContent = analysis.sanitizedText
    .slice(0, 12000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const wrappedData = `<untrusted_data source="${safeLabel}">\n${escapedContent}\n</untrusted_data>`;
  return {
    cleanText: analysis.sanitizedText,
    flagged: analysis.flagged,
    matches: analysis.matches,
    wrappedData,
  };
}
