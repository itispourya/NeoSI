import crypto from 'node:crypto';
import { env } from '../config/env.ts';
import { extractTextFromPdfBuffer } from '../multimodal/pdf.ts';
import { safeExternalFetch, validateExternalUrlAsync } from '../security/crypto.ts';
import { sanitizeUntrustedContent } from '../security/promptGuard.ts';

export interface QualityBreakdown {
  primarySource: number;
  authorCredibility: number;
  evidenceDensity: number;
  recency: number;
  methodology: number;
  corroboration: number;
  relevance: number;
}

export interface DiscoveredSource {
  title: string;
  url: string;
  snippet: string;
  content: string;
  sourceType: 'paper' | 'repo' | 'docs' | 'encyclopedia' | 'web' | 'pdf';
  author: string | null;
  provider: 'tavily' | 'serper' | 'brave' | 'github' | 'arxiv' | 'wikipedia' | 'direct_fetch';
  reliabilityScore: number;
  qualityBreakdown: QualityBreakdown;
  publishedAt?: string;
  injectionFlagged: boolean;
  contentHash: string;
}

const PRIMARY_ORG_DOMAINS =
  /(arxiv\.org|github\.com|typescriptlang\.org|nodejs\.org|react\.dev|postgresql\.org|owasp\.org|ifrs\.org|rfc-editor\.org|w3\.org|developer\.mozilla\.org|huggingface\.co|vllm\.ai|nvidia\.com|wikipedia\.org)/i;

/**
 * Multi-factor source-quality scoring (Section 6):
 * Considers primary-source status, author/org credibility, evidence density (numbers/citations/benchmarks),
 * publication recency, methodology signals, and topical relevance.
 */
export function evaluateSourceQuality(input: {
  url: string;
  title: string;
  content: string;
  query: string;
  author?: string | null;
  publishedAt?: string | null;
  corroboratingCount?: number;
}): { reliabilityScore: number; breakdown: QualityBreakdown } {
  const lower = `${input.title} ${input.content}`.toLowerCase();
  const primarySource = PRIMARY_ORG_DOMAINS.test(input.url) ? 0.92 : /\.gov|\.edu|\.org\b/i.test(input.url) ? 0.84 : 0.55;
  const authorCredibility = input.author ? 0.85 : PRIMARY_ORG_DOMAINS.test(input.url) ? 0.82 : 0.55;

  const evidenceSignals = (input.content.match(/\b(\d+(?:\.\d+)?%|\[\d+\]|https?:\/\/|benchmark|dataset|theorem|rfc\s*\d+|standard)\b/gi) || [])
    .length;
  const evidenceDensity = Math.min(0.98, 0.45 + evidenceSignals * 0.08);

  let recency = 0.68;
  if (input.publishedAt) {
    const ageDays = (Date.now() - new Date(input.publishedAt).getTime()) / 86_400_000;
    if (Number.isFinite(ageDays)) {
      recency = ageDays < 180 ? 0.96 : ageDays < 730 ? 0.84 : 0.65;
    }
  }

  const methodology = /\b(method|experiment|evaluation|reproduc|proof|control|baseline|architecture|algorithm)\b/i.test(lower) ? 0.88 : 0.62;
  const corroboration = Math.min(0.98, 0.5 + (input.corroboratingCount || 0) * 0.16);

  const queryTerms = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const hits = queryTerms.filter((t) => lower.includes(t)).length;
  const relevance = queryTerms.length ? Math.min(0.99, 0.35 + (hits / queryTerms.length) * 0.64) : 0.7;

  const weighted =
    primarySource * 0.22 +
    authorCredibility * 0.12 +
    evidenceDensity * 0.18 +
    recency * 0.12 +
    methodology * 0.12 +
    corroboration * 0.1 +
    relevance * 0.14;

  return {
    reliabilityScore: Number(Math.max(0.25, Math.min(0.98, weighted)).toFixed(2)),
    breakdown: {
      primarySource: Number(primarySource.toFixed(2)),
      authorCredibility: Number(authorCredibility.toFixed(2)),
      evidenceDensity: Number(evidenceDensity.toFixed(2)),
      recency: Number(recency.toFixed(2)),
      methodology: Number(methodology.toFixed(2)),
      corroboration: Number(corroboration.toFixed(2)),
      relevance: Number(relevance.toFixed(2)),
    },
  };
}

export async function fetchCleanUrlContent(rawUrl: string): Promise<{ text: string; contentType: string; flagged: boolean; finalUrl: string }> {
  const { response, finalUrl, bodyBuffer, bodyText } = await safeExternalFetch(rawUrl, {
    headers: { 'User-Agent': 'Neo-ResearchBot/2.0' },
    timeoutMs: 12_000,
    maxRedirects: 4,
    maxBytes: 4_000_000,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${rawUrl}`);
  }
  const contentType = (response.headers.get('content-type') || 'text/plain').toLowerCase();

  let extracted = '';
  if (contentType.includes('application/pdf') || finalUrl.toLowerCase().endsWith('.pdf')) {
    const pdfRes = extractTextFromPdfBuffer(bodyBuffer);
    extracted = pdfRes.text || '[Binary PDF without selectable text layer]';
  } else {
    extracted = bodyText
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const guarded = sanitizeUntrustedContent(extracted.slice(0, 14000), finalUrl);
  return { text: guarded.cleanText, contentType, flagged: guarded.flagged, finalUrl };
}

function buildSourceRecord(
  query: string,
  partial: {
    title: string;
    url: string;
    snippet: string;
    content: string;
    sourceType: DiscoveredSource['sourceType'];
    author?: string | null;
    provider: DiscoveredSource['provider'];
    publishedAt?: string;
  }
): DiscoveredSource {
  const guarded = sanitizeUntrustedContent(partial.content || partial.snippet, partial.url);
  const quality = evaluateSourceQuality({
    url: partial.url,
    title: partial.title,
    content: guarded.cleanText,
    query,
    author: partial.author,
    publishedAt: partial.publishedAt,
  });
  const contentHash = crypto.createHash('sha256').update(guarded.cleanText).digest('hex').slice(0, 32);

  return {
    title: partial.title,
    url: partial.url,
    snippet: partial.snippet.slice(0, 280),
    content: guarded.cleanText,
    sourceType: partial.sourceType,
    author: partial.author ?? null,
    provider: partial.provider,
    reliabilityScore: guarded.flagged ? Math.min(quality.reliabilityScore, 0.45) : quality.reliabilityScore,
    qualityBreakdown: quality.breakdown,
    publishedAt: partial.publishedAt,
    injectionFlagged: guarded.flagged,
    contentHash,
  };
}

async function searchGithubRepositories(query: string): Promise<DiscoveredSource[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=3`;
    const { response, bodyText } = await safeExternalFetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Neo-ResearchBot/2.0' },
      timeoutMs: 8_000,
    });
    if (!response.ok) return [];
    const json = JSON.parse(bodyText) as {
      items?: Array<{
        full_name: string;
        html_url: string;
        description: string | null;
        stargazers_count: number;
        updated_at: string;
        language: string | null;
        owner?: { login?: string };
      }>;
    };
    return (json.items || []).map((repo) =>
      buildSourceRecord(query, {
        title: `GitHub: ${repo.full_name}`,
        url: repo.html_url,
        snippet: `${repo.description || 'Open-source repository'} (${repo.stargazers_count} stars, ${repo.language || 'multi-lang'})`,
        content: `Repository ${repo.full_name}: ${repo.description || ''}. Language: ${repo.language || 'unknown'}. Stars: ${repo.stargazers_count}. Updated: ${repo.updated_at}.`,
        sourceType: 'repo',
        author: repo.owner?.login || null,
        provider: 'github',
        publishedAt: repo.updated_at,
      })
    );
  } catch {
    return [];
  }
}

async function searchArxivPapers(query: string): Promise<DiscoveredSource[]> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=3`;
    const { response, bodyText } = await safeExternalFetch(url, { timeoutMs: 8_000 });
    if (!response.ok) return [];
    const entries = bodyText.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map((entry) => {
      const title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'arXiv Paper').replace(/\s+/g, ' ').trim();
      const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\s+/g, ' ').trim();
      const idUrl = (entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] || 'https://arxiv.org').trim();
      const published = (entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] || '').trim();
      const author = (entry.match(/<author>\s*<name>([\s\S]*?)<\/name>/)?.[1] || '').trim() || null;
      return buildSourceRecord(query, {
        title: `arXiv: ${title}`,
        url: idUrl,
        snippet: summary.slice(0, 260),
        content: `${title}\n\n${summary}`,
        sourceType: 'paper',
        author,
        provider: 'arxiv',
        publishedAt: published,
      });
    });
  } catch {
    return [];
  }
}

async function searchWikipedia(query: string): Promise<DiscoveredSource[]> {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=2&utf8=&format=json`;
    const { response, bodyText } = await safeExternalFetch(url, {
      headers: { 'User-Agent': 'Neo-ResearchBot/2.0' },
      timeoutMs: 7_000,
    });
    if (!response.ok) return [];
    const data = JSON.parse(bodyText) as {
      query?: { search?: Array<{ title: string; pageid: number; snippet: string; timestamp?: string }> };
    };
    return (data.query?.search || []).map((item) => {
      const cleanSnippet = item.snippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const pageUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/\s+/g, '_'))}`;
      return buildSourceRecord(query, {
        title: `Wikipedia: ${item.title}`,
        url: pageUrl,
        snippet: cleanSnippet,
        content: `${item.title}: ${cleanSnippet}`,
        sourceType: 'encyclopedia',
        author: 'Wikipedia Contributors',
        provider: 'wikipedia',
        publishedAt: item.timestamp,
      });
    });
  } catch {
    return [];
  }
}

export async function discoverWebKnowledge(topic: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];
  const seenUrls = new Set<string>();
  const { getDb } = await import('../db/adapter.ts');
  const { evaluateDomainPolicy } = await import('../knowledge/feeds.ts');
  const db = await getDb();
  const policies = await db.listKnowledgePolicies().then((list) => list.filter((p) => p.enabled)).catch(() => []);

  const pushUnique = async (item: DiscoveredSource) => {
    if (!item.url || seenUrls.has(item.url)) return;
    const policyCheck = evaluateDomainPolicy(item.url, policies);
    if (!policyCheck.allowed) return;
    if (item.reliabilityScore < policyCheck.minReliability && !policyCheck.trusted) return;
    const check = await validateExternalUrlAsync(item.url);
    if (!check.valid) return;
    if (policyCheck.trusted) {
      item.reliabilityScore = Math.min(0.98, Number((item.reliabilityScore + 0.06).toFixed(2)));
    }
    seenUrls.add(item.url);
    results.push(item);
  };

  // 1. Optional non-AI SERP APIs (Tavily / Serper / Brave) when configured
  if (env.tavilyApiKey) {
    try {
      const { response, bodyText } = await safeExternalFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.tavilyApiKey, query: topic, max_results: 4, include_raw_content: false }),
        timeoutMs: 12_000,
      });
      if (response.ok) {
        const data = JSON.parse(bodyText) as { results?: Array<{ title: string; url: string; content: string }> };
        for (const r of data.results || []) {
          await pushUnique(
            buildSourceRecord(topic, {
              title: r.title,
              url: r.url,
              snippet: r.content.slice(0, 240),
              content: r.content,
              sourceType: 'web',
              provider: 'tavily',
            })
          );
        }
      }
    } catch {
      // Fall back to direct public sources
    }
  }

  if (env.serperApiKey && results.length < 3) {
    try {
      const { response, bodyText } = await safeExternalFetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.serperApiKey },
        body: JSON.stringify({ q: topic, num: 4 }),
        timeoutMs: 10_000,
      });
      if (response.ok) {
        const data = JSON.parse(bodyText) as { organic?: Array<{ title: string; link: string; snippet: string }> };
        for (const r of data.organic || []) {
          await pushUnique(
            buildSourceRecord(topic, {
              title: r.title,
              url: r.link,
              snippet: r.snippet,
              content: r.snippet,
              sourceType: 'web',
              provider: 'serper',
            })
          );
        }
      }
    } catch {
      // continue
    }
  }

  if (env.braveSearchApiKey && results.length < 3) {
    try {
      const { response, bodyText } = await safeExternalFetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topic)}&count=4`,
        {
          headers: { 'X-Subscription-Token': env.braveSearchApiKey, Accept: 'application/json' },
          timeoutMs: 10_000,
        }
      );
      if (response.ok) {
        const data = JSON.parse(bodyText) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
        for (const r of data.web?.results || []) {
          await pushUnique(
            buildSourceRecord(topic, {
              title: r.title,
              url: r.url,
              snippet: r.description,
              content: r.description,
              sourceType: 'web',
              provider: 'brave',
            })
          );
        }
      }
    } catch {
      // continue
    }
  }

  // 2. Always query independent public technical/encyclopedic indexes (arXiv, GitHub, Wikipedia)
  const [gh, ax, wp] = await Promise.all([
    searchGithubRepositories(topic),
    searchArxivPapers(topic),
    searchWikipedia(topic),
  ]);
  for (const item of [...ax, ...gh, ...wp]) {
    await pushUnique(item);
  }

  return results.slice(0, 8);
}
