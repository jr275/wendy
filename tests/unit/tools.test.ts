/** Tool safety: public-internet-only fetching (SSRF), documents confined to one folder, text extraction. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { createPrincipal } from '../../src/events/world.js';
import { confine, documentTools } from '../../src/tools/documents.js';
import { htmlToText } from '../../src/tools/html.js';
import { checkUrl, guardedLookup, isPublicAddress, safeFetch, type HopFn } from '../../src/tools/net.js';
import { ToolError } from '../../src/tools/types.js';
import { createTestDb } from '../helpers/db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let principalId: string;
let root: string;
let outside: string;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
  principalId = await createPrincipal(db, { displayName: 'P', primaryEmail: 'p@example.test', timezone: 'UTC', locale: 'pt-BR' });
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wendy-docs-'));
  root = path.join(base, 'Documentos');
  outside = path.join(base, 'secret.txt');
  await fs.mkdir(path.join(root, 'contratos'), { recursive: true });
  await fs.writeFile(outside, 'SEGREDO FORA DA PASTA');
  await fs.writeFile(path.join(root, 'contratos', 'academia.md'), '# Contrato da academia\n\nPrazo de 12 meses.\n\nMulta de 2 mensalidades.');
  await fs.writeFile(path.join(root, '.oculto.txt'), 'não listar');
  await fs.writeFile(path.join(root, 'planilha.xlsx'), 'binário');
  await fs.symlink(outside, path.join(root, 'atalho.txt'));
  const pdf = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    '4 0 obj<</Length 44>>stream',
    'BT /F1 18 Tf 20 100 Td (Prazo: 30 dias) Tj ET',
    'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n');
  await fs.writeFile(path.join(root, 'aviso.pdf'), pdf);
});
afterAll(() => t.drop());

const ctx = () => ({ db, principalId, now: new Date('2026-10-08T12:00:00Z') });

describe('SSRF guard', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['8.8.8.8', '142.250.0.1', '2607:f8b0::1']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("refuses Wendy's own local services, other schemes, odd ports and credentials before any network use", () => {
    for (const u of ['http://127.0.0.1:3457/api/today', 'http://localhost:3458/agui', 'http://[::1]/', 'file:///etc/passwd', 'ftp://example.com/x', 'https://example.com:8443/', 'https://user:pw@example.com/', 'http://169.254.169.254/latest/meta-data', 'http://wendy.local/'])
      expect(() => checkUrl(u), u).toThrow(ToolError);
    expect(checkUrl('https://example.com/a?b=1').hostname).toBe('example.com');
  });

  it('refuses a hostname that resolves to a private address (DNS rebinding is pinned at connect time)', async () => {
    const lookup = guardedLookup(async () => ['93.184.216.34', '10.0.0.7']);
    const err = await new Promise<Error | null>((resolve) => lookup('rebind.example.com', {}, (e) => resolve(e)));
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('BLOCKED');
  });

  it('checks every redirect target', async () => {
    const hop: HopFn = async (url) =>
      url.hostname === 'public.example.com' ? { status: 302, location: 'http://127.0.0.1:3457/api/write/policy', contentType: '', body: Buffer.alloc(0) } : { status: 200, location: null, contentType: 'text/html', body: Buffer.from('secret') };
    await expect(safeFetch('https://public.example.com/start', { hop })).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('only reads textual pages', async () => {
    const hop: HopFn = async () => ({ status: 200, location: null, contentType: 'application/octet-stream', body: Buffer.from('x') });
    await expect(safeFetch('https://example.com/file.bin', { hop })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe('documents folder', () => {
  it('lists only readable, non-hidden regular files inside the folder (symlinks are not listed)', async () => {
    const files = await documentTools({ root })['documents.list'].run(ctx(), {});
    expect(files.map((f) => f.path)).toEqual(['aviso.pdf', path.join('contratos', 'academia.md')]);
  });

  it('refuses traversal, absolute paths and symlinks that escape the folder', async () => {
    await expect(confine(root, '../secret.txt')).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(confine(root, outside)).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(documentTools({ root })['documents.read'].run(ctx(), { path: 'atalho.txt' })).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(documentTools({ root })['documents.read'].run(ctx(), { path: 'planilha.xlsx' })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('reads markdown and PDF text and stores what was read as a citable source', async () => {
    const tools = documentTools({ root });
    const md = await tools['documents.read'].run(ctx(), { path: 'contratos/academia.md' });
    const pdf = await tools['documents.read'].run(ctx(), { path: 'aviso.pdf' });
    expect(pdf.pages).toBe(1);
    const rows = (await db.query('SELECT id, kind, uri, content FROM captured_sources WHERE id = ANY($1::uuid[]) ORDER BY uri', [[md.sourceId, pdf.sourceId]])).rows;
    expect(rows.map((r) => [r.kind, r.uri])).toEqual([
      ['document', 'documents:aviso.pdf'],
      ['document', `documents:${path.join('contratos', 'academia.md')}`],
    ]);
    expect(rows[0].content).toContain('Prazo: 30 dias');
    expect(rows[1].content).toContain('Multa de 2 mensalidades');
  });
});

describe('html to text', () => {
  it('drops scripts, styles and markup; keeps title and paragraphs; decodes entities', () => {
    const r = htmlToText('<html><head><title>T&iacute;tulo &amp; mais</title><style>p{}</style></head><body><script>steal()</script><p>Olá&nbsp;mundo</p><p>R$ 1.000 &#8212; ok</p></body></html>');
    expect(r.title).toBe('T&iacute;tulo & mais');
    expect(r.text).toBe('Olá mundo\nR$ 1.000 — ok');
  });
});
