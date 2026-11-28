import crypto from 'node:crypto';
import { getDb } from '../db/adapter.ts';
import type { EpistemicStatus, KnowledgePolicyRecord } from '../db/schema.ts';
import { safeExternalFetch, validateExternalUrlAsync } from '../security/crypto.ts';
import { sanitizeUntrustedContent } from '../security/promptGuard.ts';
import { knowledgeGraph } from './graph.ts';
import { storeMemory } from './memory.ts';

export interface ParsedFeedItem {
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
  author: string | null;
  contentHash: string;
  injectionFlagged: boolean;
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractXmlTag(block: string, tagName: string): string {
  const re = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = block.match(re);
  return match ? decodeXmlEntities(match[1]) : '';
}

function extractAtomLink(block: string): string {
  const alt = block.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*\/?>/i);
  if (alt?.[1]) return alt[1].trim();
  const anyHref = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
  if (anyHref?.[1]) return anyHref[1].trim();
  return extractXmlTag(block, 'link');
}

export function parseRssOrAtomFeed(xmlText: string, sourceUrl: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = [];
  const rssItems = xmlText.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const atomEntries = xmlText.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];
  const rawBlocks = rssItems.length > 0 ? rssItems : atomEntries;

  for (const blk of rawBlocks.slice(0, 15)) {
    const title = extractXmlTag(blk, 'title') || 'Feed Entry';
    const rawLink = rssItems.length > 0 ? extractXmlTag(blk, 'link') : extractAtomLink(blk);
    const link = rawLink && /^https?:\/\//i.test(rawLink) ? rawLink : sourceUrl;
    const rawSummary =
      extractXmlTag(blk, 'content:encoded') ||
      extractXmlTag(blk, 'content') ||
      extractXmlTag(blk, 'description') ||
      extractXmlTag(blk, 'summary') ||
      title;
    const publishedRaw =
      extractXmlTag(blk, 'pubDate') ||
      extractXmlTag(blk, 'updated') ||
      extractXmlTag(blk, 'published') ||
      extractXmlTag(blk, 'dc:date');
    const publishedAt = publishedRaw && !Number.isNaN(Date.parse(publishedRaw))
      ? new Date(publishedRaw).toISOString()
      : null;
    const author = extractXmlTag(blk, 'author') || extractXmlTag(blk, 'dc:creator') || null;

    const guarded = sanitizeUntrustedContent(`${title}\n${rawSummary}`.slice(0, 4000), link);
    const contentHash = crypto.createHash('sha256').update(guarded.cleanText).digest('hex').slice(0, 32);
    items.push({
      title: title.slice(0, 200),
      url: link,
      summary: guarded.cleanText,
      publishedAt,
      author,
      contentHash,
      injectionFlagged: guarded.flagged,
    });
  }
  return items;
}

export function parseGithubReleasesJson(jsonText: string, repoSlug: string): ParsedFeedItem[] {
  const parsed = JSON.parse(jsonText) as Array<{
    name?: string;
    tag_name?: string;
    html_url?: string;
    body?: string;
    published_at?: string;
    author?: { login?: string };
    draft?: boolean;
  }>;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r) => !r.draft)
    .slice(0, 8)
    .map((rel) => {
      const title = `${repoSlug} ${rel.name || rel.tag_name || 'Release'}`.trim();
      const url = rel.html_url || `https://github.com/${repoSlug}/releases`;
      const body = (rel.body || title).slice(0, 4000);
      const guarded = sanitizeUntrustedContent(`${title}\n${body}`, url);
      const contentHash = crypto.createHash('sha256').update(guarded.cleanText).digest('hex').slice(0, 32);
      return {
        title: title.slice(0, 200),
        url,
        summary: guarded.cleanText,
        publishedAt: rel.published_at || null,
        author: rel.author?.login || null,
        contentHash,
        injectionFlagged: guarded.flagged,
      };
    });
}

function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase().trim().replace(/^\*\./, '');
  return h === p || h.endsWith(`.${p}`);
}

export function evaluateDomainPolicy(
  urlStr: string,
  policies: KnowledgePolicyRecord[]
): { allowed: boolean; trusted: boolean; minReliability: number; reason: string } {
  let minReliability = 0.45;
  for (const p of policies) {
    if (p.enabled && Number.isFinite(p.min_reliability) && p.min_reliability > 0) {
      minReliability = Math.max(minReliability, p.min_reliability);
    }
  }

  let hostname = '';
  try {
    hostname = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return { allowed: false, trusted: false, minReliability, reason: 'Invalid URL' };
  }

  for (const p of policies) {
    if (p.enabled && p.rule_type === 'blocked_domain' && hostMatchesPattern(hostname, p.pattern)) {
      return { allowed: false, trusted: false, minReliability, reason: `Domain '${hostname}' blocked by policy '${p.pattern}'` };
    }
  }

  const trusted = policies.some(
    (p) => p.enabled && p.rule_type === 'trusted_domain' && hostMatchesPattern(hostname, p.pattern)
  );

  return {
    allowed: true,
    trusted,
    minReliability,
    reason: trusted ? `Matched trusted domain policy` : 'Allowed by default policy',
  };
}

export function classifyEpistemicStatus(input: {
  content: string;
  trustedDomain: boolean;
  corroboratingSources: number;
}): EpistemicStatus {
  const lower = input.content.toLowerCase();
  if (/\b(i think|in my opinion|rumor|unconfirmed|speculation)\b/i.test(lower)) {
    return 'opinion';
  }
  if (/\b(will likely|forecast|projected to|prediction|expected by 20)\b/i.test(lower)) {
    return 'prediction';
  }
  if (input.corroboratingSources >= 2 && input.trustedDomain) {
    return 'verified_fact';
  }
  if (input.corroboratingSources >= 2) {
    return 'verified_fact';
  }
  return 'observation';
}

export interface FeedSyncReport {
  feedsChecked: number;
  skippedNotModified: number;
  skippedDeduplicated: number;
  itemsIngested: number;
  errors: string[];
}

export async function ingestConfiguredFeeds(opts: {
  tenantId?: string;
  fetchFn?: typeof fetch;
  allowLocalTestFetch?: boolean;
} = {}): Promise<FeedSyncReport> {
  const db = await getDb();
  const tenantId = opts.tenantId || 'global';
  const allPolicies = await db.listKnowledgePolicies();
  const policies = allPolicies.filter((p) => p.enabled);
  const feedPolicies = policies.filter((p) => p.rule_type === 'feed_source');

  let feedsChecked = 0;
  let skippedNotModified = 0;
  let skippedDeduplicated = 0;
  let itemsIngested = 0;
  const errors: string[] = [];

  const existingSources = await db.listKnowledgeSources(tenantId, 200);
  const sourceByUrl = new Map(existingSources.map((s) => [s.url, s]));

  for (const feed of feedPolicies) {
    const isGithubReleases = feed.source_kind === 'github_releases' || /^github_releases:/i.test(feed.pattern);
    const repoSlug = isGithubReleases ? feed.pattern.replace(/^github_releases:/i, '').trim() : '';
    const feedUrl = isGithubReleases
      ? `https://api.github.com/repos/${repoSlug}/releases?per_page=5`
      : feed.pattern.trim();

    if (!opts.allowLocalTestFetch) {
      const domainCheck = evaluateDomainPolicy(feedUrl, policies);
      if (!domainCheck.allowed) {
        errors.push(`${feedUrl}: ${domainCheck.reason}`);
        continue;
      }
      const ssrf = await validateExternalUrlAsync(feedUrl);
      if (!ssrf.valid) {
        errors.push(`${feedUrl}: ${ssrf.reason || 'Blocked by SSRF policy'}`);
        continue;
      }
    }

    feedsChecked++;
    const existingFeedRecord = sourceByUrl.get(feedUrl);
    const headers: Record<string, string> = {
      'User-Agent': 'Neo-KnowledgeFeed/2.0',
      ...(isGithubReleases ? { Accept: 'application/vnd.github+json' } : {}),
    };
    if (existingFeedRecord?.etag) headers['If-None-Match'] = existingFeedRecord.etag;
    if (existingFeedRecord?.last_modified) headers['If-Modified-Since'] = existingFeedRecord.last_modified;

    try {
      let status = 200;
      let etag: string | null = null;
      let lastModified: string | null = null;
      let bodyText = '';

      if (opts.fetchFn) {
        const res = await opts.fetchFn(feedUrl, { headers, signal: AbortSignal.timeout(10_000) });
        status = res.status;
        etag = res.headers.get('etag');
        lastModified = res.headers.get('last-modified');
        if (status !== 304) bodyText = await res.text();
      } else {
        const fetched = await safeExternalFetch(feedUrl, { headers, timeoutMs: 10_000, maxBytes: 2_000_000 });
        status = fetched.response.status;
        etag = fetched.response.headers.get('etag');
        lastModified = fetched.response.headers.get('last-modified');
        bodyText = fetched.bodyText;
      }

      if (status === 304) {
        skippedNotModified++;
        if (existingFeedRecord) {
          await db.upsertKnowledgeSource({
            ...existingFeedRecord,
            last_verified_at: new Date().toISOString(),
            review_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          });
        }
        continue;
      }

      if (status < 200 || status >= 300) {
        errors.push(`${feedUrl}: HTTP ${status}`);
        continue;
      }

      const feedHash = crypto.createHash('sha256').update(bodyText).digest('hex').slice(0, 32);
      if (existingFeedRecord?.content_hash === feedHash) {
        skippedDeduplicated++;
        await db.upsertKnowledgeSource({
          ...existingFeedRecord,
          etag: etag || existingFeedRecord.etag,
          last_modified: lastModified || existingFeedRecord.last_modified,
          last_verified_at: new Date().toISOString(),
          review_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        });
        continue;
      }

      await db.upsertKnowledgeSource({
        tenant_id: tenantId,
        url: feedUrl,
        title: `Feed: ${feed.pattern}`,
        source_type: isGithubReleases ? 'github_releases' : 'rss_feed',
        author: null,
        published_at: null,
        last_verified_at: new Date().toISOString(),
        reliability_score: 0.85,
        quality_breakdown: {
          primarySource: 0.85,
          authorCredibility: 0.8,
          evidenceDensity: 0.75,
          recency: 1.0,
          methodology: 0.8,
          corroboration: 0.7,
          relevance: 0.85,
        },
        content_hash: feedHash,
        etag,
        last_modified: lastModified,
        review_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        injection_flagged: false,
      });

      const items = isGithubReleases
        ? parseGithubReleasesJson(bodyText, repoSlug)
        : parseRssOrAtomFeed(bodyText, feedUrl);

      const topic = typeof feed.metadata?.topic === 'string' && feed.metadata.topic.trim()
        ? feed.metadata.topic.trim()
        : isGithubReleases
        ? `Release Notes: ${repoSlug}`
        : 'Subscribed Knowledge Feed';

      const domainPolicy = evaluateDomainPolicy(feedUrl, policies);

      for (const item of items.slice(0, 6)) {
        const existingItem = sourceByUrl.get(item.url);
        if (existingItem && existingItem.content_hash === item.contentHash) {
          skippedDeduplicated++;
          continue;
        }
        await db.upsertKnowledgeSource({
          tenant_id: tenantId,
          url: item.url,
          title: item.title,
          source_type: isGithubReleases ? 'release_note' : 'feed_item',
          author: item.author,
          published_at: item.publishedAt,
          last_verified_at: new Date().toISOString(),
          reliability_score: item.injectionFlagged ? 0.35 : domainPolicy.trusted ? 0.88 : 0.74,
          quality_breakdown: {
            primarySource: domainPolicy.trusted ? 0.9 : 0.7,
            authorCredibility: 0.75,
            evidenceDensity: 0.75,
            recency: 0.95,
            methodology: 0.7,
            corroboration: domainPolicy.trusted ? 0.85 : 0.55,
            relevance: 0.8,
          },
          content_hash: item.contentHash,
          etag: null,
          last_modified: null,
          review_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
          injection_flagged: item.injectionFlagged,
        });

        if (item.injectionFlagged) continue;

        const epistemic = classifyEpistemicStatus({
          content: item.summary,
          trustedDomain: domainPolicy.trusted,
          corroboratingSources: domainPolicy.trusted ? 2 : 1,
        });

        await storeMemory({
          tenantId,
          memoryType: 'semantic',
          topic,
          title: item.title,
          content: item.summary.slice(0, 1400),
          structuredFacts: {
            sourceFeed: feed.pattern,
            publishedAt: item.publishedAt,
            contentHash: item.contentHash,
            epistemicStatus: epistemic,
          },
          sourceUrl: item.url,
          reliabilityScore: domainPolicy.trusted ? 0.88 : 0.75,
          epistemicStatus: epistemic,
          validTo: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        });
        await knowledgeGraph.extractFromText(tenantId, `${item.title} ${item.summary.slice(0, 400)}`, item.url);
        itemsIngested++;
      }
    } catch (err) {
      errors.push(`${feedUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { feedsChecked, skippedNotModified, skippedDeduplicated, itemsIngested, errors };
}

export async function revalidateStaleKnowledgeSources(tenantId = 'global'): Promise<{
  checked: number;
  staleCount: number;
}> {
  const db = await getDb();
  const sources = await db.listKnowledgeSources(tenantId, 200);
  const nowMs = Date.now();
  let staleCount = 0;

  for (const src of sources) {
    const reviewAtMs = src.review_at ? Date.parse(src.review_at) : 0;
    const isDue = reviewAtMs > 0 ? reviewAtMs <= nowMs : nowMs - Date.parse(src.last_verified_at) > 14 * 86_400_000;
    if (isDue) {
      staleCount++;
      await db.upsertKnowledgeSource({
        ...src,
        reliability_score: Math.max(0.35, Number((src.reliability_score * 0.92).toFixed(2))),
        review_at: new Date(nowMs + 7 * 86_400_000).toISOString(),
      });
    }
  }

  return { checked: sources.length, staleCount };
}
