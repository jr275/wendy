import { notFound } from "next/navigation";
import { Character3D } from "@/components/concierge/character-3d";

/**
 * DEV ONLY — the 3D layer's FAILURE path, with no network to any third party. The scene address below is a local file that does not exist, so
 * the 3D scene cannot load: the 2D portrait underneath must stay exactly as it is, with no layout change and no error shown to the person.
 * (The real switch and the real scenes live in the registry and are off by default; see docs/SPLINE_3D.md.)
 */
export default function Characters3DFixture() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <p className="eyebrow">Desenvolvimento · sem rede externa</p>
      <h1 className="display mt-3 text-3xl tracking-tight">Personagem 3D: falha cai no 2D</h1>
      <p className="mt-2 text-muted">À esquerda, só o retrato 2D. À direita, o mesmo retrato com a camada 3D apontando para um arquivo local que não existe.</p>
      <div className="mt-8 flex items-center gap-10">
        <span className="char-slot" data-visible="true" aria-hidden>
          <span className="char" data-interaction="idle" data-size="primary" style={{ "--char-accent": "#e0a526" } as React.CSSProperties}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/characters/joy.webp" alt="" width={48} height={48} draggable={false} />
          </span>
        </span>
        <span className="char-slot" data-visible="true" data-testid="with3d" aria-hidden>
          <span className="char" data-interaction="idle" data-size="primary" style={{ "--char-accent": "#e0a526" } as React.CSSProperties}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/characters/joy.webp" alt="" width={48} height={48} draggable={false} />
            <Character3D scene="/dev/personagens3d/inexistente/scene.splinecode" />
          </span>
        </span>
      </div>
    </main>
  );
}
