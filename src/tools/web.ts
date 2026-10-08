/**
 * web.search and web.fetch (both READ).
 *
 * Search returns only *where to look* (title + URL). Nothing the search model writes is used as a
 * fact: facts come from pages Wendy actually fetched and stored (captured_sources).
 */
import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { finishModelCall, recordModelCall } from '../cognition/llm.js';
import type { Db } from '../db/db.js';
import { newId } from '../util/hash.js';
import { htmlToText } from './html.js';
import { safeFetch, type HopFn, type Resolver } from './net.js';
import { captureSource } from './sources.js';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool } from './types.js';

export interface WebSearchResult {
  title: string;
  uri: string;
}

/** Where web searches come from. Swappable (tests use a fixed list). */
export interface WebSearchProvider {
  readonly name: string;
  search(principalId: string, query: string, max: number): Promise<WebSearchResult[]>;
}

/**
 * Google Search grounding through Gemini on Vertex (principal's decision, 2026-10-08). Each search is
 * recorded in model_calls like any other model call, so it is labeled "not Claude" and auditable.
 */
export class GeminiWebSearch implements WebSearchProvider {
  readonly name = 'gemini-google-search';
  private readonly ai: Pick<GoogleGenAI, 'models'>;
  constructor(
    private readonly db: Db,
    private readonly model: string = process.env.GEMINI_MODEL ?? 'gemini-3.1-pro-preview',
    ai?: Pick<GoogleGenAI, 'models'>,
  ) {
    if (ai) this.ai = ai;
    else {
      const project = process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error('web search requires GOOGLE_CLOUD_PROJECT (Vertex AI)');
      this.ai = new GoogleGenAI({ vertexai: true, project, location: process.env.GEMINI_LOCATION ?? 'global' });
    }
  }

  async search(principalId: string, query: string, max: number): Promise<WebSearchResult[]> {
    const id = newId();
    const prompt = `Search the web for recent, reliable public pages about: ${query}\nAnswer in two sentences at most; the sources are what matter.`;
    await recordModelCall(this.db, { id, principalId, purpose: 'tool:web.search', model: this.model, input: { user: prompt, provider: 'vertex-gemini', tool: 'googleSearch' }, evidenceRefs: [], startedAt: new Date() });
    try {
      // Only the grounding sources matter, so thinking is kept low and the answer short; a tight token
      // limit made the model stop (MAX_TOKENS) before any grounding was attached.
      const r = await this.ai.models.generateContent({
        model: this.model,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }], maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'LOW' as never } },
      });
      const chunks = r.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const seen = new Set<string>();
      const results: WebSearchResult[] = [];
      for (const c of chunks) {
        const uri = c.web?.uri;
        if (!uri || seen.has(uri)) continue;
        seen.add(uri);
        results.push({ title: c.web?.title ?? c.web?.domain ?? uri, uri });
        if (results.length >= max) break;
      }
      await finishModelCall(this.db, id, { output: { results }, usage: r.usageMetadata, servedBy: r.modelVersion ?? this.model, apiMessageId: r.responseId, stopReason: r.candidates?.[0]?.finishReason ?? null });
      return results;
    } catch (err) {
      await finishModelCall(this.db, id, { error: err instanceof Error ? err.message : String(err) });
      throw new ToolError('UPSTREAM', `web search failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }
}

const MAX_PAGE_CHARS = 20_000;

export function webTools(deps: { search: WebSearchProvider; hop?: HopFn; resolve?: Resolver }) {
  const search: ReadTool<{ query: string; max: number }, WebSearchResult[]> = {
    spec: TOOL_SPECS['web.search'],
    input: z.object({ query: z.string().min(2).max(300), max: z.number().int().min(1).max(8) }),
    run: (ctx, i) => deps.search.search(ctx.principalId, i.query, i.max),
  };

  const fetch: ReadTool<{ url: string }, { sourceId: string; url: string; title: string | null; chars: number }> = {
    spec: TOOL_SPECS['web.fetch'],
    input: z.object({ url: z.string().min(8).max(2000) }),
    run: async (ctx, i) => {
      const page = await safeFetch(i.url, { hop: deps.hop, resolve: deps.resolve });
      const { title, text } = /html/i.test(page.contentType) ? htmlToText(page.text) : { title: null, text: page.text.trim() };
      if (text.length < 80) throw new ToolError('UNSUPPORTED', `page has almost no readable text (${text.length} chars)`);
      const clipped = text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[…truncated]` : text;
      const s = await captureSource(ctx.db, { principalId: ctx.principalId, kind: 'web_page', uri: page.url, title, content: clipped, executionId: ctx.executionId, now: ctx.now });
      return { sourceId: s.id, url: page.url, title, chars: clipped.length };
    },
  };

  return { 'web.search': search, 'web.fetch': fetch };
}
