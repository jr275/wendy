/**
 * What Wendy says aloud, and which answer is the one to say. Pure.
 *
 * Only the answer to a turn the person started BY VOICE is spoken (never the history, never an answer to something typed). Cards, tables and
 * code are not read out: the written answer stays the full record, the voice is a short version of it.
 */
import type { ConversationItem } from "../conversation";

const REF = /\s*\[(?:C|E|P|M|MT|MEM|SC|I|A|R|W|D|T)\d+\]/g; // evidence handles like [C1]
export const SPEAK_MAX = 900;

/** Markdown → plain, speakable text. Links keep their label; code and tables are replaced by a short spoken note; the end is trimmed on a sentence. */
export function speakableText(markdown: string): string {
  let t = markdown;
  let skipped = false;
  t = t.replace(/```[\s\S]*?```/g, () => ((skipped = true), " "));
  t = t.replace(/^\s*\|.*\|\s*$/gm, () => ((skipped = true), " ")); // table rows
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1"); // links → label
  t = t.replace(/https?:\/\/\S+/g, "um link"); // bare URLs
  t = t.replace(REF, "");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s*/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "");
  t = t.replace(/(\*\*|__|~~|\*|_)/g, "");
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return skipped ? "Mostrei o resultado na tela." : "";
  if (t.length > SPEAK_MAX) {
    const cut = t.slice(0, SPEAK_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = `${(end > 200 ? cut.slice(0, end + 1) : cut).trim()} O resto está na tela.`;
  } else if (skipped) t = `${t} O restante está na tela.`;
  return t;
}

/** The answer to the user message `userId`: the assistant text that follows it, up to the next user message. null when it is not there yet. */
export function replyAfter(items: readonly ConversationItem[], userId: string): string | null {
  const at = items.findIndex((i) => i.kind === "user" && i.id === userId);
  if (at < 0) return null;
  const texts: string[] = [];
  for (let i = at + 1; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind === "user") break;
    if (it.kind === "assistant") texts.push(it.text);
  }
  return texts.length ? texts.join("\n\n") : null;
}

/** Splits long text on sentence boundaries (browsers cut a long utterance short); every piece is at most `max` characters. */
export function chunkForSpeech(text: string, max = 200): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const sentence of text.split(/(?<=[.!?…])\s+/)) {
    if (sentence.length > max) {
      push();
      let rest = sentence;
      while (rest.length > max) {
        const at = rest.lastIndexOf(" ", max);
        const k = at > max / 2 ? at : max;
        out.push(rest.slice(0, k).trim());
        rest = rest.slice(k).trim();
      }
      cur = rest;
    } else if ((cur ? cur.length + 1 : 0) + sentence.length > max) {
      push();
      cur = sentence;
    } else cur = cur ? `${cur} ${sentence}` : sentence;
  }
  push();
  return out;
}

export type ReplyDecision = { do: "wait" } | { do: "failed" } | { do: "reply"; text: string };

/**
 * What to do for the spoken turn `userId`, given the conversation right now. Pure.
 *  - a run is still going → wait (the answer arrives whole, but never speak while Wendy is still working);
 *  - the turn failed → failed (nothing to speak);
 *  - the answer to THIS message is there → speak it (its speakable form);
 *  - the run finished and there is no text for this message (cards only) → an empty reply: nothing to speak, back to idle;
 *  - otherwise → wait.
 */
export function decideReply(i: { items: readonly ConversationItem[]; userId: string; error: string | null; running: boolean; runDone: boolean }): ReplyDecision {
  if (i.running) return { do: "wait" };
  if (i.error) return { do: "failed" };
  const reply = replyAfter(i.items, i.userId);
  if (reply !== null) return { do: "reply", text: speakableText(reply) };
  return i.runDone ? { do: "reply", text: "" } : { do: "wait" };
}
