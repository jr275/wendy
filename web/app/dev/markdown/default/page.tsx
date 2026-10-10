import { notFound } from "next/navigation";
import { DefaultMarkdown } from "./default-markdown";
import { CASES } from "../cases";

/** DEV ONLY — the same cases with CopilotKit's DEFAULT renderer (what the conversation used before), for comparison. */
export default function DefaultMarkdownFixture() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Markdown — renderizador padrão (antes, dev)</h1>
      {CASES.map((c) => (
        <section key={c.id} data-case={c.id} className="mt-6 rounded-xl border border-line p-4">
          <DefaultMarkdown content={c.md} />
        </section>
      ))}
    </main>
  );
}
