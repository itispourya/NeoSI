import { env } from '../config/env.ts';
import { routeLlmCall } from '../llm/router.ts';
import { validateExternalUrl } from '../security/crypto.ts';

export interface DiscoveredSource {
  title: string;
  url: string;
  snippet: string;
  content: string;
  provider: 'tavily' | 'serper' | 'brave' | 'gemini_grounding' | 'github' | 'arxiv' | 'jina_reader';
  reliabilityScore: number;
  publishedAt?: string;
}

const TRUSTED_DOMAIN_WEIGHTS: Array<[RegExp, number]> = [
  [/github\.com/i, 0.92],
  [/arxiv\.org/i, 0.95],
  [/typescriptlang\.org|nodejs\.org|react\.dev|postgresql\.org|owasp\.org|ifrs\.org/i, 0.98],
  [/developer\.mozilla\.org|web\.dev/i, 0.95],
  [/stackoverflow\.com|martinfowler\.com/i, 0.88],
];

export function scoreSourceReliability(url: string, contentLength: number): number {
  let score = 0.72;
  for (const [pattern, weight] of TRUSTED_DOMAIN_WEIGHTS) {
    if (pattern.test(url)) {
      score = Math.max(score, weight);
      break;
    }
  }
  if (contentLength > 800) score = Math.min(0.99, score + 0.04);
  if (contentLength < 120) score = Math.max(0.45, score - 0.15);
  return Number(score.toFixed(2));
}

export async function fetchCleanUrlContent(rawUrl: string): Promise<string> {
  const check = validateExternalUrl(rawUrl);
  if (!check.valid) {
    throw new Error(`Blocked URL (${check.reason}): ${rawUrl}`);
  }

  // Try Jina Reader if Firecrawl is not set
  if (env.firecrawlApiKey) {
    try {
      const fc = await fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.firecrawlApiKey}` },
        body: JSON.stringify({ url: rawUrl, formats: ['markdown'] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (fc.ok) {
        const json = (await fc.json()) as { data?: { markdown?: string } };
        if (json.data?.markdown) return json.data.markdown.slice(0, 12000);
      }
    } catch {
      // fallback below
    }
  }

  const res = await fetch(rawUrl, {
    headers: { 'User-Agent': 'NeoAI-KnowledgeCrawler/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rawUrl}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12000);
}

async function searchGithubRepositories(query: string): Promise<DiscoveredSource[]> {
  try {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=3`;
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'NeoAI-Crawler' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      items?: Array<{ full_name: string; html_url: string; description: string | null; stargazers_count: number; updated_at: string; language: string | null }>;
    };
    return (json.items || []).map((repo) => ({
      title: `GitHub: ${repo.full_name}`,
      url: repo.html_url,
      snippet: `${repo.description || 'Repository'} (${repo.stargazers_count} stars, ${repo.language || 'multi-lang'})`,
      content: `Repository ${repo.full_name}: ${repo.description || ''}. Primary language: ${repo.language || 'unknown'}. Stars: ${repo.stargazers_count}. Updated: ${repo.updated_at}.`,
      provider: 'github',
      reliabilityScore: scoreSourceReliability(repo.html_url, 300),
      publishedAt: repo.updated_at,
    }));
  } catch {
    return [];
  }
}

async function searchArxivPapers(query: string): Promise<DiscoveredSource[]> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=2`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const xml = await res.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    return entries.map((entry) => {
      const title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || 'arXiv Paper').replace(/\s+/g, ' ').trim();
      const summary = (entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').replace(/\s+/g, ' ').trim();
      const idUrl = (entry.match(/<id>([\s\S]*?)<\/id>/)?.[1] || 'https://arxiv.org').trim();
      const published = (entry.match(/<published>([\s\S]*?)<\/published>/)?.[1] || '').trim();
      return {
        title: `arXiv: ${title}`,
        url: idUrl,
        snippet: summary.slice(0, 240),
        content: `${title}\n\n${summary}`,
        provider: 'arxiv',
        reliabilityScore: 0.95,
        publishedAt: published,
      };
    });
  } catch {
    return [];
  }
}

export async function discoverWebKnowledge(topic: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];
  const seenUrls = new Set<string>();

  const pushUnique = (item: DiscoveredSource) => {
    if (!item.url || seenUrls.has(item.url)) return;
    const check = validateExternalUrl(item.url);
    if (!check.valid) return;
    seenUrls.add(item.url);
    results.push(item);
  };

  // 1. Dedicated Search Providers (Tavily / Serper / Brave) if configured
  if (env.tavilyApiKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: env.tavilyApiKey, query: topic, max_results: 4, include_raw_content: false }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
        for (const r of data.results || []) {
          pushUnique({
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, 240),
            content: r.content,
            provider: 'tavily',
            reliabilityScore: scoreSourceReliability(r.url, r.content.length),
          });
        }
      }
    } catch {
      // continue to fallbacks
    }
  }

  if (env.serperApiKey && results.length < 3) {
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.serperApiKey },
        body: JSON.stringify({ q: topic, num: 4 }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { organic?: Array<{ title: string; link: string; snippet: string }> };
        for (const r of data.organic || []) {
          pushUnique({
            title: r.title,
            url: r.link,
            snippet: r.snippet,
            content: r.snippet,
            provider: 'serper',
            reliabilityScore: scoreSourceReliability(r.link, r.snippet.length),
          });
        }
      }
    } catch {
      // continue
    }
  }

  if (env.braveSearchApiKey && results.length < 3) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topic)}&count=4`, {
        headers: { 'X-Subscription-Token': env.braveSearchApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
        for (const r of data.web?.results || []) {
          pushUnique({
            title: r.title,
            url: r.url,
            snippet: r.description,
            content: r.description,
            provider: 'brave',
            reliabilityScore: scoreSourceReliability(r.url, r.description.length),
          });
        }
      }
    } catch {
      // continue
    }
  }

  // 2. Gemini Google Search Grounding (real-time web verification)
  if (env.geminiApiKey && env.geminiApiKey !== 'MY_GEMINI_API_KEY') {
    try {
      const grounded = await routeLlmCall({
        prompt: `Research the latest authoritative best practices, engineering patterns, or enterprise standards on: "${topic}". Provide a dense technical summary with concrete rules, metrics, or code patterns.`,
        taskType: 'web_discovery',
        useSearchGrounding: true,
        preferredProvider: 'gemini',
      });
      const sources = grounded.groundingSources || [];
      if (sources.length > 0) {
        for (const s of sources.slice(0, 3)) {
          pushUnique({
            title: s.title,
            url: s.url,
            snippet: grounded.text.slice(0, 260),
            content: grounded.text,
            provider: 'gemini_grounding',
            reliabilityScore: scoreSourceReliability(s.url, grounded.text.length),
          });
        }
      } else if (grounded.text) {
        results.push({
          title: `Grounded Synthesis: ${topic}`,
          url: 'https://ai.google.dev/',
          snippet: grounded.text.slice(0, 260),
          content: grounded.text,
          provider: 'gemini_grounding',
          reliabilityScore: 0.86,
        });
      }
    } catch {
      // fallback to GitHub & arXiv
    }
  }

  // 3. Always enrich with live GitHub & arXiv technical discovery
  const [gh, ax] = await Promise.all([searchGithubRepositories(topic), searchArxivPapers(topic)]);
  for (const item of [...gh, ...ax]) pushUnique(item);

  return results.slice(0, 8);
}
