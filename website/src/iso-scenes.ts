// Isometric icons built from the demo's ideas: a calendar is a slab, an original meeting a solid
// block in its calendar's colour, and a copy a flat hatched block in the colour of its source.
import type { Box } from "./iso";

const slab = "var(--iso-slab)";
const tint = (colour: string) => `color-mix(in srgb, ${colour} 16%, var(--iso-slab))`;

// Icons for the showcase cards.
export const icons: Record<string, Box[]> = {
  // A meeting moved to a later slot, and its copy moved with it.
  moves: [
    { x: 0, y: 0, z: 0, w: 4, d: 7, h: 0.5, colour: slab },
    { x: 5, y: 0, z: 0, w: 4, d: 7, h: 0.5, colour: slab },
    { x: 0.5, y: 3.5, z: 0.5, w: 3, d: 2, h: 1.2, colour: "var(--work)" },
    {
      x: 5.5,
      y: 3.5,
      z: 0.5,
      w: 3,
      d: 2,
      h: 0.25,
      colour: tint("var(--work)"),
      hatch: "var(--work)",
    },
  ],
  // Several calendars stacked into one block group.
  more: [
    { x: 0, y: 0, z: 0, w: 6, d: 6, h: 0.5, colour: tint("var(--private)") },
    { x: 0, y: 0, z: 1, w: 6, d: 6, h: 0.5, colour: tint("var(--client)") },
    { x: 0, y: 0, z: 2, w: 6, d: 6, h: 0.5, colour: tint("var(--work)") },
    { x: 1, y: 1.5, z: 2.5, w: 4, d: 2, h: 1, colour: "var(--work)" },
  ],
};
