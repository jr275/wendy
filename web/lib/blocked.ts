/**
 * The renderer's security pass (rehype-harden) replaces a blocked image or link with English text and
 * has no translation option. Only the words shown to the principal are mapped here, by exact pattern:
 * what gets blocked, and why, is decided by the renderer and is not touched.
 */
const IMAGE = /^\[Image blocked: ([\s\S]*)\]$/;
const LINK = /^( ?)\[blocked\]$/;
const URL_TITLE = /^Blocked URL: ([\s\S]*)$/;

/** Text of a blocked image/link in pt-BR; any other text comes back unchanged. */
export function translateBlockedText(text: string): string {
  const img = IMAGE.exec(text);
  if (img) return `[imagem não carregada: ${img[1] === "No description" ? "sem descrição" : img[1]}]`;
  const link = LINK.exec(text);
  if (link) return `${link[1]}[link bloqueado]`;
  return text;
}

export function translateBlockedTitle(title: string): string {
  const m = URL_TITLE.exec(title);
  if (!m) return title;
  return m[1] === "undefined" ? "URL bloqueada" : `URL bloqueada: ${m[1]}`; // the renderer prints "undefined" when the link had no href
}
