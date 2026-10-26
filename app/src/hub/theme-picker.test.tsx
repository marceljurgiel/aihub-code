// Ported from AIhub-TUI v1.5.0 app/src/theme.test.tsx.
/** Themes: palettes and accents apply live everywhere, Esc in the picker puts
 *  back what was there, Enter saves.
 *  aihub-code: the picker is opened as a panel opens it; what it saves goes to
 *  its onSave (aihub-code's own settings file, Task 10), and the theme AIhub's
 *  config.yaml names is not applied at start-up (ruling R-T2-2), so that test
 *  is not ported. Unknown names fall back to aihub-code's default theme. */
import { test, expect, afterEach } from "bun:test";
import { ThemeModal } from "./modals/ThemeModal.tsx";
import { MockBridge, openWindow, type Opened } from "./test-tree.tsx";
import { ACCENTS, DEFAULT_THEME, THEMES, activeTheme, applyTheme, logoGradient, theme } from "./theme.ts";

let setup: Opened["setup"] | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  applyTheme();
});

async function until(pred: (f: string) => boolean, tries = 40, label = "") {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 40));
    await setup!.flush();
    const f = setup!.captureCharFrame();
    if (pred(f)) return f;
  }
  throw new Error(`frame never matched (${label} theme=${activeTheme.name} accent=${activeTheme.accent}):\n` + setup!.captureCharFrame());
}

test("a theme and an accent replace the palette; unknown names fall back", () => {
  applyTheme("nord", "orange");
  expect(theme.bg0).toBe(THEMES.nord!.palette.bg0);
  expect(theme.accent).toBe(ACCENTS.orange!.accent);
  expect(logoGradient[2]).toBe(ACCENTS.orange!.accent);
  applyTheme("light", "");
  // On a light canvas the logo runs dark → accent, never towards white.
  expect(logoGradient[3]).toBe(THEMES.light!.palette.accent);
  applyTheme("no-such-theme", "no-such-accent");
  expect(activeTheme).toEqual({ name: DEFAULT_THEME, accent: "" });
  expect(theme.accent).toBe(THEMES[DEFAULT_THEME]!.palette.accent);
});

test("the picker: arrows preview live, Esc restores, Enter saves", async () => {
  applyTheme("aihub", "");
  const saves: Array<[string, string]> = [];
  const win = await openWindow(new MockBridge(), (close) => (
    <ThemeModal onSave={(name, accent) => saves.push([name, accent])} onClose={close} />
  ));
  setup = win.setup;
  await until((f) => f.includes("Tokyo Night") && f.includes("accent"));
  // aihub-code lists its terminal theme first: down from aihub is tokyo-night.
  setup.mockInput.pressArrow("down");
  await until(() => activeTheme.name === "tokyo-night", 40, "down");
  setup.mockInput.pressArrow("right"); // first accent after "theme's own"
  await until(() => activeTheme.accent === "purple", 40, "right");
  expect(theme.bg0).toBe(THEMES["tokyo-night"]!.palette.bg0);
  setup.mockInput.pressEscape();
  await until(() => activeTheme.name === "aihub" && activeTheme.accent === "", 40, "esc");
  expect(saves).toEqual([]);
  expect(win.isOpen()).toBe(false);

  win.reopen();
  await until((f) => f.includes("Tokyo Night"));
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressArrow("down");
  await until(() => activeTheme.name === "catppuccin", 40, "down2");
  setup.mockInput.pressEnter();
  await until(() => !win.isOpen(), 40, "saved");
  expect(saves).toEqual([["catppuccin", ""]]);
  expect(activeTheme.name).toBe("catppuccin");
});
