"use client";
import { useEffect, useId, useRef, useState } from "react";
import { characterFor, CHARACTERS, hasAnyScene } from "@/lib/characters";
import { use3dEnabled } from "./use-3d-preference";
import { MOOD_CATEGORIES, MOOD_CHOICE_LABEL, MOOD_LABEL, type MoodCategory, type MoodPrefs, type MoodPresentation, type Selection } from "@/lib/mood";

/**
 * The user's control over the presentation: see how Wendy read the moment, correct it, pick a
 * character, switch the characters off. Wording is careful: it is a guess about tone for the
 * interface, not a diagnosis, and it changes nothing about what Wendy does.
 */
export function MoodControl({ selection, reading, prefs, onPrefs, onCorrect }: { selection: Selection; reading: MoodPresentation | null; prefs: MoodPrefs; onPrefs: (p: MoodPrefs) => void; onCorrect: () => void }) {
  const [open, setOpen] = useState(false);
  const [on3d, set3d] = use3dEnabled();
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const showing = selection.basis === "reading" && reading;
  const picked = (c: MoodCategory | "neutral") => onPrefs({ ...prefs, selected: c });
  const choices = MOOD_CATEGORIES.filter((c) => characterFor(c));
  return (
    <div className="relative">
      <button ref={btn} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)} className="rounded-full border border-line px-3 py-1 text-xs text-ink-2 hover:bg-surface-2">
        Personagens
      </button>
      {open ? (
        <div ref={panel} id={panelId} role="group" aria-label="Personagens e leitura de humor" className="absolute right-0 top-full z-30 mt-2 w-72 rounded-2xl border border-line bg-surface p-4 text-sm shadow-lg">
          <p className="text-ink-2">
            {!prefs.enabled
              ? "Os personagens estão desligados."
              : prefs.selected
                ? `Você escolheu: ${prefs.selected === "neutral" ? "neutro" : MOOD_CHOICE_LABEL[prefs.selected]}.`
                : showing
                  ? `Pelo tom desta conversa, ela parece ${MOOD_LABEL[reading!.category]}. É só uma leitura aproximada (${Math.round(reading!.confidence * 100)}% de confiança), para a aparência — não muda nada do que a Wendy faz.`
                  : "Sem sinal claro de humor: aparência neutra."}
          </p>
          {showing ? (
            <button
              type="button"
              onClick={() => {
                onCorrect();
                setOpen(false);
                btn.current?.focus();
              }}
              className="mt-3 w-full rounded-full border border-line px-3 py-1.5 text-ink-2 hover:bg-surface-2"
            >
              Não é isso — voltar ao neutro
            </button>
          ) : null}
          <fieldset className="mt-4">
            <legend className="eyebrow mb-2">Escolher a aparência</legend>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={prefs.selected === null} onClick={() => onPrefs({ ...prefs, selected: null })} className={`rounded-full border px-2.5 py-1 ${prefs.selected === null ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                Automático
              </button>
              <button type="button" aria-pressed={prefs.selected === "neutral"} onClick={() => picked("neutral")} className={`rounded-full border px-2.5 py-1 ${prefs.selected === "neutral" ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                Neutro
              </button>
              {choices.map((c) => {
                const ch = CHARACTERS[characterFor(c)!];
                return (
                  <button key={c} type="button" aria-pressed={prefs.selected === c} onClick={() => picked(c)} className={`rounded-full border px-2.5 py-1 ${prefs.selected === c ? "border-accent bg-accent-soft text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>
                    {MOOD_CHOICE_LABEL[c] === ch.label ? ch.label : `${MOOD_CHOICE_LABEL[c]} · ${ch.label}`}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <label className="mt-4 flex items-center gap-2 text-ink-2">
            <input type="checkbox" checked={prefs.enabled} onChange={(e) => onPrefs({ ...prefs, enabled: e.target.checked })} />
            Mostrar personagens
          </label>
          {hasAnyScene() ? (
            <label className="mt-2 flex items-start gap-2 text-ink-2">
              <input type="checkbox" className="mt-1" checked={on3d} disabled={!prefs.enabled} onChange={(e) => set3d(e.target.checked)} />
              <span>
                Personagens em 3D
                <span className="block text-xs text-muted">Carrega a cena do Spline (um serviço de terceiros). Desligado, nada é pedido a eles.</span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
