/**
 * documents.list and documents.read (READ), confined to ONE authorized folder.
 * Paths are resolved through realpath and must stay inside the folder (no "..", no symlink escape).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { captureSource } from './sources.js';
import { TOOL_SPECS } from './specs.js';
import { ToolError, type ReadTool } from './types.js';

export const DOCUMENT_LIMITS = { maxBytes: 10_000_000, maxFiles: 200, maxDepth: 4, maxChars: 60_000 };
const READABLE = new Set(['.txt', '.md', '.markdown', '.pdf']);

export function defaultDocumentsRoot(): string {
  return process.env.WENDY_DOCUMENTS_DIR ?? path.join(os.homedir(), 'Wendy', 'Documentos');
}

async function realRoot(root: string): Promise<string> {
  try {
    return await fs.realpath(root);
  } catch {
    throw new ToolError('NOT_FOUND', `the documents folder ${root} does not exist`);
  }
}

/** Resolves a path given relative to the root; refuses anything that ends up outside it. */
export async function confine(root: string, rel: string): Promise<string> {
  const base = await realRoot(root);
  if (path.isAbsolute(rel)) throw new ToolError('BLOCKED', 'paths must be relative to the documents folder');
  let real: string;
  try {
    real = await fs.realpath(path.resolve(base, rel));
  } catch {
    throw new ToolError('NOT_FOUND', `no such document: ${rel}`);
  }
  if (real !== base && !real.startsWith(base + path.sep)) throw new ToolError('BLOCKED', 'path is outside the documents folder');
  return real;
}

async function extract(file: string, buf: Buffer): Promise<{ text: string; pages: number | null }> {
  if (path.extname(file).toLowerCase() === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      return { text, pages: totalPages };
    } catch (e) {
      throw new ToolError('UNSUPPORTED', `could not read PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { text: buf.toString('utf-8'), pages: null };
}

export function documentTools(deps: { root: string }) {
  const list: ReadTool<Record<string, never>, { path: string; bytes: number; modifiedAt: string }[]> = {
    spec: TOOL_SPECS['documents.list'],
    input: z.object({}).strict(),
    run: async () => {
      const base = await realRoot(deps.root);
      const out: { path: string; bytes: number; modifiedAt: string }[] = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > DOCUMENT_LIMITS.maxDepth || out.length >= DOCUMENT_LIMITS.maxFiles) return;
        for (const d of await fs.readdir(dir, { withFileTypes: true })) {
          if (d.name.startsWith('.')) continue;
          const p = path.join(dir, d.name);
          if (d.isDirectory()) await walk(p, depth + 1);
          else if (d.isFile() && READABLE.has(path.extname(d.name).toLowerCase())) {
            const st = await fs.stat(p);
            out.push({ path: path.relative(base, p), bytes: st.size, modifiedAt: st.mtime.toISOString() });
            if (out.length >= DOCUMENT_LIMITS.maxFiles) return;
          }
        }
      };
      await walk(base, 0);
      return out.sort((a, b) => a.path.localeCompare(b.path));
    },
  };

  const read: ReadTool<{ path: string }, { sourceId: string; path: string; title: string; pages: number | null; chars: number; truncated: boolean }> = {
    spec: TOOL_SPECS['documents.read'],
    input: z.object({ path: z.string().min(1).max(500) }),
    run: async (ctx, i) => {
      const file = await confine(deps.root, i.path);
      if (!READABLE.has(path.extname(file).toLowerCase())) throw new ToolError('UNSUPPORTED', `only ${[...READABLE].join(', ')} files can be read`);
      const st = await fs.stat(file);
      if (!st.isFile()) throw new ToolError('NOT_FOUND', `${i.path} is not a file`);
      if (st.size > DOCUMENT_LIMITS.maxBytes) throw new ToolError('TOO_LARGE', `${i.path} is larger than ${DOCUMENT_LIMITS.maxBytes} bytes`);
      const { text, pages } = await extract(file, await fs.readFile(file));
      const clean = text.replace(/\r\n/g, '\n').trim();
      if (!clean) throw new ToolError('UNSUPPORTED', `${i.path} has no readable text (scanned PDF?)`);
      const truncated = clean.length > DOCUMENT_LIMITS.maxChars;
      const content = truncated ? clean.slice(0, DOCUMENT_LIMITS.maxChars) : clean;
      const rel = path.relative(await realRoot(deps.root), file);
      const s = await captureSource(ctx.db, { principalId: ctx.principalId, kind: 'document', uri: `documents:${rel}`, title: path.basename(file), content, executionId: ctx.executionId, now: ctx.now });
      return { sourceId: s.id, path: rel, title: path.basename(file), pages, chars: content.length, truncated };
    },
  };

  return { 'documents.list': list, 'documents.read': read };
}
