/**
 * Test helper for jsx.test.ts (not part of the app): renders one AIhub window
 * frame and prints it. Run from another directory with AIHUB_GLYPHS=ascii-safe,
 * it shows that hub files carry their own console-safe JSX runtime (the
 * per-file pragma), whatever directory Bun starts in.
 */
import { createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ModalShell } from "../ui/ModalShell.tsx";

const setup = await testRender(createElement(ModalShell, { title: "Probe", width: 40, hints: [["↵", "go"]], children: null }), {
  width: 60,
  height: 12,
});
await setup.renderOnce();
console.log(setup.captureCharFrame());
setup.renderer.destroy();
