import { notFound } from "next/navigation";
import { SafeMarkdown } from "@/components/concierge/markdown";
import { CASES } from "./cases";

/**
 * DEV ONLY — security fixture for the conversation's Markdown renderer. Each case is rendered with
 * the exact component the home conversation uses; a browser check inspects the DOM and the network.
 * Hostnames are reserved example domains; the browser check blocks every non-local request.
 */
export default function MarkdownFixture() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Markdown — casos de segurança (dev)</h1>
      {CASES.map((c) => (
        <section key={c.id} data-case={c.id} className="mt-6 rounded-xl border border-line p-4">
          <SafeMarkdown content={c.md} />
        </section>
      ))}
    </main>
  );
}
