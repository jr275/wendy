import { stripRefs } from "@/lib/format";

/** First sentence as the lead, the rest at reading size. */
export function Lead({ text, size = "lg" }: { text: string | null | undefined; size?: "lg" | "xl" }) {
  const t = stripRefs(text);
  if (!t) return null;
  const cut = t.search(/[.!?](\s|$)/);
  const lead = cut > 0 ? t.slice(0, cut + 1) : t;
  const rest = cut > 0 ? t.slice(cut + 1).trim() : "";
  return (
    <div>
      <p className={`${size === "xl" ? "text-2xl sm:text-[28px]" : "text-xl sm:text-2xl"} font-medium leading-snug tracking-tight`}>{lead}</p>
      {rest ? <p className="mt-3 max-w-3xl text-[17px] leading-relaxed text-ink-2">{rest}</p> : null}
    </div>
  );
}
