/**
 * 3D character scenes (web/lib/scene3d.ts and the registry in web/lib/characters.ts). Pure: no browser, no network, no Spline.
 * What is proven: only a Spline-hosted scene address is ever accepted; 3D loads only when EVERY condition holds; and with no scene
 * configured (today) nothing can load.
 */
import { describe, expect, it } from 'vitest';
import { CHARACTER_IDS, CHARACTERS, hasAnyScene, sceneOf } from '../../web/lib/characters.js';
import { isAllowedSceneUrl, shouldLoad3D, SPLINE_HOST, type Load3DInput } from '../../web/lib/scene3d.js';

const OK = `https://${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.splinecode`; // the shape only; this test never contacts it

describe('isAllowedSceneUrl: only a Spline scene address', () => {
  it('accepts exactly https://prod.spline.design/<id>/scene.splinecode', () => {
    expect(isAllowedSceneUrl(OK)).toBe(true);
    expect(isAllowedSceneUrl(`https://${SPLINE_HOST}/abcdefgh12/scene.splinecode`)).toBe(true);
  });
  it('refuses another host, a look-alike host, a subdomain, and an IP', () => {
    for (const u of [
      'https://spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode',
      'https://prod.spline.design.evil.test/6Wq1Q7YGyM-iab9i/scene.splinecode',
      'https://evil.test/prod.spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode',
      'https://x.prod.spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode',
      'https://prod-spline.design/6Wq1Q7YGyM-iab9i/scene.splinecode',
      'https://127.0.0.1/6Wq1Q7YGyM-iab9i/scene.splinecode',
    ]) expect(isAllowedSceneUrl(u), u).toBe(false);
  });
  it('refuses http, other schemes, credentials, a port, a query and a fragment', () => {
    for (const u of [
      `http://${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `javascript:alert(1)//${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `data:text/html,<script>alert(1)</script>`,
      `https://user:pw@${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `https://${SPLINE_HOST}:8443/6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `${OK}?x=1`,
      `${OK}#frag`,
    ]) expect(isAllowedSceneUrl(u), u).toBe(false);
  });
  it('refuses the wrong file, a wrong id shape, extra path parts, traversal and encoded tricks', () => {
    for (const u of [
      `https://${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.json`,
      `https://${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/other/scene.splinecode`,
      `https://${SPLINE_HOST}/short/scene.splinecode`,
      `https://${SPLINE_HOST}/${'a'.repeat(41)}/scene.splinecode`,
      `https://${SPLINE_HOST}/../6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `https://${SPLINE_HOST}/6Wq1Q7YGyM%2Fiab9i/scene.splinecode`,
      `https://${SPLINE_HOST}/6Wq1Q7YGyM-iab9i/scene.splinecode/`,
      `https://${SPLINE_HOST}//6Wq1Q7YGyM-iab9i/scene.splinecode`,
      `https://${SPLINE_HOST}/6Wq1Q7YGyM iab9i/scene.splinecode`,
    ]) expect(isAllowedSceneUrl(u), u).toBe(false);
  });
  it('refuses anything that is not a clean string: whitespace, non-strings, empty, very long', () => {
    for (const v of [` ${OK}`, `${OK} `, `${OK}\n`, '', null, undefined, 42, {}, [OK], `${OK}${'a'.repeat(300)}`]) expect(isAllowedSceneUrl(v), String(v)).toBe(false);
  });
});

describe('shouldLoad3D: every condition must hold', () => {
  const base: Load3DInput = { sceneUrl: OK, enabled: true, reducedMotion: false, visible: true, awaiting: false, saveData: false };
  it('loads when everything is right', () => {
    expect(shouldLoad3D(base)).toBe(true);
  });
  it('does not load when any single condition fails, so 2D stays and nothing is requested from Spline', () => {
    const fails: Partial<Load3DInput>[] = [{ sceneUrl: null }, { sceneUrl: undefined }, { sceneUrl: 'https://evil.test/x/scene.splinecode' }, { enabled: false }, { reducedMotion: true }, { visible: false }, { awaiting: true }, { saveData: true }];
    for (const f of fails) expect(shouldLoad3D({ ...base, ...f }), JSON.stringify(f)).toBe(false);
  });
  it('the default (person has not turned 3D on) never loads, even with a valid scene', () => {
    expect(shouldLoad3D({ ...base, enabled: false })).toBe(false);
  });
});

describe('registry today: no scene configured, so nothing can load', () => {
  it('every character is 2D only, and the 3D switch has nothing to offer', () => {
    for (const id of CHARACTER_IDS) expect(sceneOf(CHARACTERS[id]), id).toBeNull();
    expect(hasAnyScene()).toBe(false);
  });
  it('sceneOf returns a scene only when it is an allowed address; a bad one is ignored, not loaded', () => {
    expect(sceneOf({ scene: OK })).toBe(OK);
    expect(sceneOf({ scene: 'https://evil.test/x/scene.splinecode' })).toBeNull();
    expect(sceneOf({ scene: undefined })).toBeNull();
    expect(sceneOf({})).toBeNull();
    expect(sceneOf(null)).toBeNull();
    expect(sceneOf(undefined)).toBeNull();
  });
});
