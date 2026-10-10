"use client";
import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";

/** DEV ONLY — CopilotKit's default Markdown renderer, unmodified (the "before" of the image policy). */
export function DefaultMarkdown({ content }: { content: string }) {
  return <CopilotChatAssistantMessage.MarkdownRenderer content={content} />;
}
