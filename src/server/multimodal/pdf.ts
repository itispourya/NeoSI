import zlib from 'node:zlib';

/**
 * Pure TypeScript PDF text extractor using Node's native zlib.
 * Extracts uncompressed and FlateDecode stream text operators (Tj / TJ) without external AI APIs or native binaries.
 */
export function extractTextFromPdfBuffer(buf: Buffer): { text: string; pagesEstimated: number; ok: boolean } {
  const rawLatin = buf.toString('latin1');
  if (!rawLatin.startsWith('%PDF')) {
    return { text: '', pagesEstimated: 0, ok: false };
  }

  const pageMatches = rawLatin.match(/\/Type\s*\/Page\b/g);
  const pagesEstimated = Math.max(1, pageMatches ? pageMatches.length : 1);

  const chunks: string[] = [];
  const collectTextOperators = (streamStr: string) => {
    // Match (text) Tj or [(text)...] TJ operators
    const literalRuns = streamStr.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g);
    for (const m of literalRuns) {
      const cleaned = decodePdfEscapes(m[1]);
      if (cleaned.trim()) chunks.push(cleaned);
    }
    const arrayRuns = streamStr.matchAll(/\[((?:[^[\]]|\([^)]*\))*)\]\s*TJ/g);
    for (const m of arrayRuns) {
      const inner = m[1].matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g);
      const parts: string[] = [];
      for (const p of inner) parts.push(decodePdfEscapes(p[1]));
      const joined = parts.join('');
      if (joined.trim()) chunks.push(joined);
    }
  };

  // Scan binary PDF streams cleanly
  let searchPos = 0;
  const streamToken = Buffer.from('stream');
  const endStreamToken = Buffer.from('endstream');

  while (searchPos < buf.length) {
    const startIdx = buf.indexOf(streamToken, searchPos);
    if (startIdx === -1) break;
    let dataStart = startIdx + streamToken.length;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buf[dataStart] === 0x0a || buf[dataStart] === 0x0d) dataStart += 1;

    const endIdx = buf.indexOf(endStreamToken, dataStart);
    if (endIdx === -1) break;

    const slice = buf.subarray(dataStart, endIdx);
    // Attempt FlateDecode inflate, fallback to raw text stream
    let decodedStr: string;
    try {
      decodedStr = zlib.inflateSync(slice).toString('latin1');
    } catch {
      decodedStr = slice.toString('latin1');
    }
    collectTextOperators(decodedStr);
    searchPos = endIdx + endStreamToken.length;
  }

  // Fallback for uncompressed simple PDF text
  if (chunks.length === 0) {
    collectTextOperators(rawLatin);
  }

  const text = chunks
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60_000);

  return { text, pagesEstimated, ok: text.length > 0 };
}

function decodePdfEscapes(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}
