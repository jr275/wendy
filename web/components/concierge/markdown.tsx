"use client";
import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";

/**
 * Markdown for model- and user-generated text. CopilotKit's renderer is Streamdown with its default
 * chain (rehype-raw → rehype-sanitize with the GitHub schema → rehype-harden), which already strips
 * scripts, event handlers, iframes and unsafe URL schemes. On top of that, images are never loaded:
 * an <img> in an answer would make the browser contact whatever server the text names (tracking,
 * network metadata). There is no first-party image policy to allow, so every image becomes its
 * alt text. The sanitizing chain itself is not changed.
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

export function SafeMarkdown({ content }: { content: string }) {
  return <CopilotChatAssistantMessage.MarkdownRenderer content={content} components={SAFE_COMPONENTS} />;
}
