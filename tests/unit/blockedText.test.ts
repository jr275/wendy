/** The renderer's English placeholders for blocked images/links are shown in pt-BR; nothing else is touched. */
import { describe, expect, it } from 'vitest';
import { translateBlockedText, translateBlockedTitle } from '../../web/lib/blocked.js';

describe('blocked image/link text', () => {
  it('translates the image placeholder, keeping the alt text', () => {
    expect(translateBlockedText('[Image blocked: dados]')).toBe('[imagem não carregada: dados]');
    expect(translateBlockedText('[Image blocked: No description]')).toBe('[imagem não carregada: sem descrição]');
  });
  it('translates the link placeholder, keeping the leading space', () => {
    expect(translateBlockedText(' [blocked]')).toBe(' [link bloqueado]');
  });
  it('translates the blocked-URL title and keeps the URL', () => {
    expect(translateBlockedTitle('Blocked URL: javascript:alert(1)')).toBe('URL bloqueada: javascript:alert(1)');
  });
  it('does not show the renderer\'s "undefined" when the link had no href', () => {
    expect(translateBlockedTitle('Blocked URL: undefined')).toBe('URL bloqueada');
  });
  it('is idempotent and leaves any other text alone', () => {
    for (const t of ['[imagem não carregada: x]', ' [link bloqueado]', 'Image blocked: x', 'olá [blocked] mundo', 'Copy Code']) expect(translateBlockedText(t)).toBe(t);
    expect(translateBlockedTitle('URL bloqueada: x')).toBe('URL bloqueada: x');
  });
});
