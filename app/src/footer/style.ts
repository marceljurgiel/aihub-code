/** Footer drawing constants that depend on the glyph set. */
import { RGBA } from "@opentui/core";
import { G } from "../glyphs";
import { colour } from "../scrollback";

/** The box border: rounded corners from the glyph set. */
export const BOX_CHARS = {
  topLeft: G.tl,
  topRight: G.tr,
  bottomLeft: G.bl,
  bottomRight: G.br,
  horizontal: G.h,
  vertical: G.v,
  topT: G.h,
  bottomT: G.h,
  leftT: G.v,
  rightT: G.v,
  cross: G.h,
};

/** Muted grey from the terminal's own palette (bright black). */
export const GREY = (): RGBA => colour("ansi:8");
/** The terminal's own text colour. */
export const FG = (): RGBA => RGBA.defaultForeground();
export const TRANSPARENT = "transparent";
