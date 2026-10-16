/**
 * 3D character scenes (Spline) — the rules, kept pure so they can be tested without a browser or a network.
 *
 * A scene is OPTIONAL artwork for a character. The 2D portrait (lib/characters.ts `src`) is always the fallback and is what shows whenever any of
 * these conditions fails. Nothing from a model, a message or the server ever names a scene: the only source is the registry, and even there the
 * address must be a Spline-hosted `scene.splinecode` (anything else is ignored, never loaded).
 *
 * Loading a scene contacts a third party (Spline's servers) from the person's browser, so it is OFF by default and is the person's choice.
 */
export const SPLINE_HOST = "prod.spline.design";
const PATH = /^\/[A-Za-z0-9_-]{8,40}\/scene\.splinecode$/;

/** True only for https://prod.spline.design/<id>/scene.splinecode — no credentials, port, query or fragment. */
export function isAllowedSceneUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 200 || raw !== raw.trim()) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === SPLINE_HOST && !u.username && !u.password && u.port === "" && u.search === "" && u.hash === "" && PATH.test(u.pathname) && raw === `https://${SPLINE_HOST}${u.pathname}`;
}

export interface Load3DInput {
  /** The scene configured in the registry for the character that is showing (or null / undefined). */
  sceneUrl: string | null | undefined;
  /** The person turned 3D characters on (per device; default off). */
  enabled: boolean;
  reducedMotion: boolean;
  /** The slot is on screen (an off-screen scene is not loaded or is released). */
  visible: boolean;
  /** An approval is waiting for the principal: nothing moves, nothing competes with it. */
  awaiting: boolean;
  /** The browser asked to save data. */
  saveData: boolean;
}

/** Whether to load the 3D scene. Every condition must hold; otherwise the 2D portrait stays and nothing is requested from Spline. */
export function shouldLoad3D(i: Load3DInput): boolean {
  return isAllowedSceneUrl(i.sceneUrl) && i.enabled && !i.reducedMotion && i.visible && !i.awaiting && !i.saveData;
}
