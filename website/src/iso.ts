// Isometric drawing for the 3D illustrations. A scene is a list of boxes on a grid; `isoBoxes`
// turns them into SVG polygons, back to front, with a lit top and two shaded sides.

export type Box = {
  x: number;
  y: number;
  z: number;
  w: number; // along x
  d: number; // along y
  h: number; // along z
  colour: string; // a CSS colour or var()
  hatch?: string; // stripe colour on the top face: a copy, hatched like the logo
};

type Face = { points: string; fill: string };

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);

function project(x: number, y: number, z: number, scale: number) {
  return [(x - y) * COS * scale, (x + y) * SIN * scale - z * scale] as const;
}

const shade = (colour: string, percent: number) =>
  `color-mix(in srgb, ${colour} ${100 - percent}%, #000)`;

export function isoBoxes(boxes: Box[], scale = 20): Face[] {
  const sorted = [...boxes].sort((a, b) => a.x + a.y + a.z - (b.x + b.y + b.z));
  const faces: Face[] = [];
  for (const box of sorted) {
    const p = (x: number, y: number, z: number) => project(x, y, z, scale).join(",");
    const { x, y, z, w, d, h } = box;
    const top = [p(x, y, z + h), p(x + w, y, z + h), p(x + w, y + d, z + h), p(x, y + d, z + h)];
    const left = [p(x, y + d, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x, y + d, z + h)];
    const right = [p(x + w, y, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x + w, y, z + h)];
    faces.push({ points: left.join(" "), fill: shade(box.colour, 18) });
    faces.push({ points: right.join(" "), fill: shade(box.colour, 32) });
    faces.push({ points: top.join(" "), fill: box.colour });
    if (box.hatch) {
      faces.push({ points: top.join(" "), fill: `url(#${box.hatch})` });
    }
  }
  return faces;
}

// The bounding box of a scene in screen coordinates, for the SVG viewBox.
export function viewBox(boxes: Box[], scale = 20, pad = 8) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const { x, y, z, w, d, h } of boxes) {
    for (const [px, py, pz] of [
      [x, y, z],
      [x + w, y, z],
      [x, y + d, z],
      [x + w, y + d, z],
      [x, y, z + h],
      [x + w, y, z + h],
      [x, y + d, z + h],
      [x + w, y + d, z + h],
    ] as const) {
      const [sx, sy] = project(px, py, pz, scale);
      xs.push(sx);
      ys.push(sy);
    }
  }
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return `${minX} ${minY} ${Math.max(...xs) - minX + pad} ${Math.max(...ys) - minY + pad}`;
}
