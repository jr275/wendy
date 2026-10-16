import { notFound } from "next/navigation";
import { VoiceBench } from "@/components/dev/voice-bench";

/** DEV ONLY — validate the REAL Web Speech providers with your microphone (see docs/VOICE_VALIDATION.md). Nothing here reaches Wendy or a model. */
export default function VoicePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
      <p className="eyebrow">Desenvolvimento · bancada de voz</p>
      <h1 className="display mt-3 text-4xl tracking-tight">Validar o microfone</h1>
      <p className="mt-2 text-muted">Os provedores de reconhecimento e de fala são os reais; a resposta é um eco rotulado como teste. Siga as etapas na ordem.</p>
      <div className="mt-8">
        <VoiceBench />
      </div>
    </main>
  );
}
