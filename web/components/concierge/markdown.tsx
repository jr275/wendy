"use client";
import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { useEffect, useRef } from "react";
import { translateBlockedText, translateBlockedTitle } from "@/lib/blocked";

/**
 * Markdown for model- and user-generated text. CopilotKit's renderer is Streamdown with its default
 * chain (rehype-raw → rehype-sanitize with the GitHub schema → rehype-harden), which already strips
 * scripts, event handlers, iframes and unsafe URL schemes. On top of that, images are never loaded:
 * an <img> in an answer would make the browser contact whatever server the text names (tracking,
 * network metadata). There is no first-party image policy to allow, so every image becomes its
 * alt text. The sanitizing chain itself is not changed.
 *
 * Wendy delivers whole answers (nothing streams), so the renderer's "complete unfinished Markdown"
 * step is switched off: with it on, an asterisk inside `code` made it close an emphasis that was never
 * opened and print a stray "*" after the paragraph.
 */
function BlockedImage({ alt }: { alt?: string }) {
  const label = alt?.trim() ? alt.trim() : "sem descrição";
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[13px] text-muted" title="Imagens em respostas não são carregadas" data-blocked-image="">
      [imagem não carregada: {label}]
    </span>
  );
}

const SAFE_COMPONENTS = { img: BlockedImage };

/**
 * The renderer's copy/download buttons are real but carry English labels, and this version has no
 * translation option. Their text is mapped here, exact matches only; anything else is left alone.
 */
const PT: Record<string, string> = {
  "Copy Code": "Copiar código",
  "Download file": "Baixar arquivo",
  "Copy table": "Copiar tabela",
  "Copy table as CSV": "Copiar tabela (CSV)",
  "Copy table as TSV": "Copiar tabela (TSV)",
  "Download table": "Baixar tabela",
  "Download table as CSV": "Baixar tabela (CSV)",
  "Download table as Markdown": "Baixar tabela (Markdown)",
};

function usePortugueseControls(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const run = () => {
      el.querySelectorAll<HTMLElement>("[title]").forEach((n) => {
        const title = n.getAttribute("title") ?? "";
        const pt = PT[title] ?? translateBlockedTitle(title);
        if (pt !== title) {
          n.setAttribute("title", pt);
          n.setAttribute("aria-label", pt);
        }
      });
      // Blocked image/link placeholders are single-text-node spans; only exact matches change (idempotent).
      el.querySelectorAll<HTMLElement>("span").forEach((n) => {
        n.childNodes.forEach((c) => {
          if (c.nodeType !== Node.TEXT_NODE || !c.nodeValue) return;
          const pt = translateBlockedText(c.nodeValue);
          if (pt !== c.nodeValue) c.nodeValue = pt;
        });
      });
    };
    run();
    const mo = new MutationObserver(run);
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title"] });
    return () => mo.disconnect();
  }, [ref]);
}

export function SafeMarkdown({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  usePortugueseControls(ref);
  return (
    <div ref={ref}>
      <CopilotChatAssistantMessage.MarkdownRenderer content={content} components={SAFE_COMPONENTS} parseIncompleteMarkdown={false} />
    </div>
  );
}
