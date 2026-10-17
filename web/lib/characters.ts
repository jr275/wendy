/**
 * Character registry — the ONLY place that maps a character id to artwork. Everything that reaches
 * the interface (a mood category from the server, a user choice) is resolved here; no id, path or
 * style ever comes from a model. Artwork: the product owner's, supplied as local files (see
 * assets/characters/README.md) and replaceable by editing `src` here.
 */
import { isAllowedSceneUrl } from "./scene3d";
import type { MoodCategory } from "./mood";

export const CHARACTER_IDS = ["joy", "anxiety", "anger", "sadness", "envy", "ennui", "disgust", "fear"] as const;
export type CharacterId = (typeof CHARACTER_IDS)[number];

export interface CharacterDef {
  id: CharacterId;
  /** Display name (pt-BR). */
  label: string;
  /** Local asset only. */
  src: string;
  /** Ring colour (a token-friendly hex; paired with a visible label elsewhere — never colour-only meaning). */
  accent: string;
  /** Mood categories this character presents. Empty = registered but not used yet. */
  categories: readonly MoodCategory[];
  /**
   * OPTIONAL 3D scene (Spline): https://prod.spline.design/<id>/scene.splinecode, published by the owner. Unset = 2D only. Anything that is not an
   * allowed address is ignored (lib/scene3d.ts). Shown only when the person turned 3D on; the 2D `src` is always the fallback.
   */
  scene?: string;
}

export const CHARACTERS: Record<CharacterId, CharacterDef> = {
  joy: { id: "joy", label: "Alegria", src: "/characters/joy.webp", accent: "#e0a526", categories: ["positive_energy"] },
  anxiety: { id: "anxiety", label: "Ansiedade", src: "/characters/anxiety.webp", accent: "#e2792f", categories: ["concerned"] },
  anger: { id: "anger", label: "Raiva", src: "/characters/anger.webp", accent: "#c8392b", categories: ["frustrated"] },
  sadness: { id: "sadness", label: "Tristeza", src: "/characters/sadness.webp", accent: "#3f6fc6", categories: ["sad"] },
  envy: { id: "envy", label: "Inveja", src: "/characters/envy.webp", accent: "#1f9a94", categories: ["curious"] },
  ennui: { id: "ennui", label: "Tédio", src: "/characters/ennui.webp", accent: "#5a55b8", categories: [] },
  disgust: { id: "disgust", label: "Nojinho", src: "/characters/disgust.webp", accent: "#3f9a3a", categories: [] },
  fear: { id: "fear", label: "Medo", src: "/characters/fear.webp", accent: "#8a55c6", categories: [] },
};

export const isCharacterId = (x: unknown): x is CharacterId => typeof x === "string" && (CHARACTER_IDS as readonly string[]).includes(x);

/** The character that presents a category, or null (e.g. "calm" has none yet → neutral presentation). */
export function characterFor(category: MoodCategory): CharacterId | null {
  return CHARACTER_IDS.find((id) => CHARACTERS[id].categories.includes(category)) ?? null;
}

/** Resolves an id through the registry; anything unknown is null (never rendered). */
export function resolveCharacter(id: unknown): CharacterDef | null {
  return isCharacterId(id) ? CHARACTERS[id] : null;
}

/** The allowed 3D scene of a character, or null (none configured, or not an allowed address). */
export function sceneOf(def: Pick<CharacterDef, "scene"> | null | undefined): string | null {
  return def && isAllowedSceneUrl(def.scene) ? def.scene : null;
}

/** Whether any character has a usable 3D scene — the 3D switch is only offered when there is something to switch on. */
export const hasAnyScene = (): boolean => CHARACTER_IDS.some((id) => sceneOf(CHARACTERS[id]) !== null) || orbScene() !== null;

/**
 * The neutral Wendy orb (Spline file "Wendy Orb", parts named in lib/orbPose.ts): shown in place of the halo when no character is presenting, and only
 * when the person turned 3D on. UNSET = nothing loads. Set it to the https://prod.spline.design/<id>/scene.splinecode address from Spline's Export → Code.
 */
export const WENDY_ORB_SCENE: string | undefined = undefined;
export const orbScene = (): string | null => (isAllowedSceneUrl(WENDY_ORB_SCENE) ? WENDY_ORB_SCENE : null);
