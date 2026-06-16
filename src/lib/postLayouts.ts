import type { Artboard, Layer, Platform } from "@/types";

export interface LayoutSlot {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PostLayoutPreset {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
  platforms: Array<Exclude<Platform, "workspace">>;
  slots: (width: number, height: number, gap: number) => LayoutSlot[];
  legacy?: boolean;
}

const SLOT = (id: string, label: string, x: number, y: number, width: number, height: number): LayoutSlot => ({
  id,
  label,
  x: Math.round(x),
  y: Math.round(y),
  width: Math.round(width),
  height: Math.round(height),
});

function gapFor(width: number, height: number) {
  return Math.max(8, Math.min(18, Math.round(Math.min(width, height) * 0.012)));
}

function grid(width: number, height: number, gap: number, columns: number, rows: number, count: number) {
  const cellW = (width - gap * (columns - 1)) / columns;
  const cellH = (height - gap * (rows - 1)) / rows;
  const slots: LayoutSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    slots.push(SLOT(`slot_${i + 1}`, `${i + 1}`, col * (cellW + gap), row * (cellH + gap), cellW, cellH));
  }
  return slots;
}

interface NaturalSlot {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const NS = (id: string, label: string, x: number, y: number, width: number, height: number): NaturalSlot => ({
  id,
  label,
  x,
  y,
  width,
  height,
});

function scaledSlots(width: number, height: number, specs: NaturalSlot[]): LayoutSlot[] {
  const naturalW = Math.max(...specs.map((slot) => slot.x + slot.width));
  const naturalH = Math.max(...specs.map((slot) => slot.y + slot.height));
  const scale = Math.min(width / naturalW, height / naturalH);
  const renderedW = naturalW * scale;
  const renderedH = naturalH * scale;
  const offsetX = (width - renderedW) / 2;
  const offsetY = (height - renderedH) / 2;
  return specs.map((slot) =>
    SLOT(slot.id, slot.label, offsetX + slot.x * scale, offsetY + slot.y * scale, slot.width * scale, slot.height * scale)
  );
}

function topHeroLayout(width: number, height: number, heroRatio: number, bottomRatios: number[], gap: number) {
  const baseW = 2400;
  const heroH = baseW / heroRatio;
  const bottomH = (baseW - gap * (bottomRatios.length - 1)) / bottomRatios.reduce((sum, ratio) => sum + ratio, 0);
  let x = 0;
  const slots: NaturalSlot[] = [NS("slot_1", "Hero", 0, 0, baseW, heroH)];
  bottomRatios.forEach((ratio, index) => {
    const slotW = ratio * bottomH;
    slots.push(NS(`slot_${index + 2}`, `${index + 2}`, x, heroH + gap, slotW, bottomH));
    x += slotW + gap;
  });
  return scaledSlots(width, height, slots);
}

function leftHeroLayout(width: number, height: number, heroRatio: number, sideRatios: number[], gap: number) {
  const baseH = 2400;
  const heroW = heroRatio * baseH;
  const sideH = (baseH - gap * (sideRatios.length - 1)) / sideRatios.length;
  const sideW = Math.max(...sideRatios.map((ratio) => ratio * sideH));
  const slots: NaturalSlot[] = [NS("slot_1", "Hero", 0, 0, heroW, baseH)];
  sideRatios.forEach((ratio, index) => {
    const slotW = ratio * sideH;
    slots.push(NS(`slot_${index + 2}`, `${index + 2}`, heroW + gap + (sideW - slotW) / 2, index * (sideH + gap), slotW, sideH));
  });
  return scaledSlots(width, height, slots);
}

function squareGrid(width: number, height: number, columns: number, rows: number, count: number, gap: number) {
  const cell = 1200;
  const slots: NaturalSlot[] = [];
  for (let index = 0; index < count; index += 1) {
    const col = index % columns;
    const row = Math.floor(index / columns);
    slots.push(NS(`slot_${index + 1}`, `${index + 1}`, col * (cell + gap), row * (cell + gap), cell, cell));
  }
  return scaledSlots(width, height, slots);
}

function fiveSquareLayout(width: number, height: number, gap: number) {
  const topCell = 1920;
  const naturalW = topCell * 2 + gap;
  const bottomCell = (naturalW - gap * 2) / 3;
  return scaledSlots(width, height, [
    NS("slot_1", "1", 0, 0, topCell, topCell),
    NS("slot_2", "2", topCell + gap, 0, topCell, topCell),
    NS("slot_3", "3", 0, topCell + gap, bottomCell, bottomCell),
    NS("slot_4", "4", bottomCell + gap, topCell + gap, bottomCell, bottomCell),
    NS("slot_5", "5", 2 * (bottomCell + gap), topCell + gap, bottomCell, bottomCell),
  ]);
}

export const POST_LAYOUTS: PostLayoutPreset[] = [
  {
    id: "single",
    label: "Single image",
    shortLabel: "1",
    description: "Một ảnh full artboard.",
    platforms: ["facebook"],
    slots: (w, h) => [SLOT("slot_1", "1", 0, 0, w, h)],
  },
  {
    id: "fb_text_image_multi",
    label: "FB text + multi image",
    shortLabel: "FB T+4",
    description: "Text + nhiều ảnh, 4 ô vuông 1440×1440.",
    platforms: ["facebook"],
    slots: (w, h, g) => squareGrid(w, h, 2, 2, 4, g),
  },
  {
    id: "fb_two_vertical",
    label: "FB 2 vertical",
    shortLabel: "FB 2V",
    description: "2 ảnh dọc, mỗi ảnh 600×1200.",
    platforms: ["facebook"],
    slots: (w, h, g) => scaledSlots(w, h, [
      NS("slot_1", "1", 0, 0, 600, 1200),
      NS("slot_2", "2", 600 + g, 0, 600, 1200),
    ]),
  },
  {
    id: "fb_two_landscape",
    label: "FB 2 landscape",
    shortLabel: "FB 2H",
    description: "2 ảnh ngang, mỗi ảnh 1200×600.",
    platforms: ["facebook"],
    slots: (w, h, g) => scaledSlots(w, h, [
      NS("slot_1", "1", 0, 0, 1200, 600),
      NS("slot_2", "2", 0, 600 + g, 1200, 600),
    ]),
  },
  {
    id: "fb_three_cover_landscape",
    label: "FB 3 cover landscape",
    shortLabel: "FB 3H",
    description: "Cover ngang 2:1 + 2 ảnh vuông.",
    platforms: ["facebook"],
    slots: (w, h, g) => topHeroLayout(w, h, 2 / 1, [1, 1], g),
  },
  {
    id: "fb_three_cover_vertical",
    label: "FB 3 cover vertical",
    shortLabel: "FB 3V",
    description: "Cover dọc 1:2 + 2 ảnh vuông.",
    platforms: ["facebook"],
    slots: (w, h, g) => leftHeroLayout(w, h, 1 / 2, [1, 1], g),
  },
  {
    id: "fb_four_square",
    label: "FB 4 square",
    shortLabel: "FB 4□",
    description: "4 ảnh vuông 1920×1920.",
    platforms: ["facebook"],
    slots: (w, h, g) => squareGrid(w, h, 2, 2, 4, g),
  },
  {
    id: "fb_four_cover_landscape",
    label: "FB 4 cover landscape",
    shortLabel: "FB 1H+3",
    description: "Cover ngang 3:2 + 3 ảnh vuông.",
    platforms: ["facebook"],
    slots: (w, h, g) => topHeroLayout(w, h, 3 / 2, [1, 1, 1], g),
  },
  {
    id: "fb_four_cover_vertical",
    label: "FB 4 cover vertical",
    shortLabel: "FB 1V+3",
    description: "Cover dọc 2:3 + 3 ảnh vuông.",
    platforms: ["facebook"],
    slots: (w, h, g) => leftHeroLayout(w, h, 2 / 3, [1, 1, 1], g),
  },
  {
    id: "fb_five_square",
    label: "FB 5+ square",
    shortLabel: "FB 5□",
    description: "5+ ảnh: 2 ảnh vuông lớn phía trên + 3 ảnh vuông phía dưới.",
    platforms: ["facebook"],
    slots: (w, h, g) => fiveSquareLayout(w, h, g),
  },
  {
    id: "fb_five_mixed",
    label: "FB 5+ mixed",
    shortLabel: "FB 2□+3H",
    description: "5+ ảnh: 2 ảnh vuông dọc + 3 ảnh ngang 1920×1280.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const square = 1920;
      const totalH = square * 2 + g;
      const rowH = (totalH - g * 2) / 3;
      const rowW = rowH * 1.5;
      return scaledSlots(w, h, [
        NS("slot_1", "1", 0, 0, square, square),
        NS("slot_2", "2", 0, square + g, square, square),
        NS("slot_3", "3", square + g, 0, rowW, rowH),
        NS("slot_4", "4", square + g, rowH + g, rowW, rowH),
        NS("slot_5", "5", square + g, 2 * (rowH + g), rowW, rowH),
      ]);
    },
  },
  {
    id: "li_three_horizontal",
    label: "LI 3 ảnh - chính ngang",
    shortLabel: "LI 3H",
    description: "Ảnh chính ngang 2048×1255 + 2 ảnh phụ 1845×1536.",
    platforms: ["linkedin"],
    slots: (w, h, g) => topHeroLayout(w, h, 2048 / 1255, [1845 / 1536, 1845 / 1536], g),
  },
  {
    id: "li_three_vertical",
    label: "LI 3 ảnh - chính dọc",
    shortLabel: "LI 3V",
    description: "Ảnh chính dọc + 2 ảnh phụ dọc, mỗi ảnh 1280×1587.",
    platforms: ["linkedin"],
    slots: (w, h, g) => leftHeroLayout(w, h, 1280 / 1587, [1280 / 1587, 1280 / 1587], g),
  },
  {
    id: "li_four_vertical_opt1",
    label: "LI 4 ảnh - dọc opt 1",
    shortLabel: "LI 4V1",
    description: "Ảnh chính dọc 2580×3177 + 3 ảnh phụ 1280×1050.",
    platforms: ["linkedin"],
    slots: (w, h, g) => scaledSlots(w, h, [
      NS("slot_1", "Hero", 0, 0, 2580, 3177),
      NS("slot_2", "2", 2580 + g, 0, 1280, 1050),
      NS("slot_3", "3", 2580 + g, 1050 + g, 1280, 1050),
      NS("slot_4", "4", 2580 + g, 2 * (1050 + g), 1280, 1050),
    ]),
  },
  {
    id: "li_four_vertical_opt2",
    label: "LI 4 ảnh - dọc opt 2",
    shortLabel: "LI 4V2",
    description: "Ảnh chính dọc 2580×3870 + 3 ảnh phụ 1080×1080.",
    platforms: ["linkedin"],
    slots: (w, h, g) => {
      const sideH = 1080 * 3 + g * 2;
      const sideY = (3870 - sideH) / 2;
      return scaledSlots(w, h, [
        NS("slot_1", "Hero", 0, 0, 2580, 3870),
        NS("slot_2", "2", 2580 + g, sideY, 1080, 1080),
        NS("slot_3", "3", 2580 + g, sideY + 1080 + g, 1080, 1080),
        NS("slot_4", "4", 2580 + g, sideY + 2 * (1080 + g), 1080, 1080),
      ]);
    },
  },
  {
    id: "li_four_horizontal",
    label: "LI 4 ảnh - ngang opt 1",
    shortLabel: "LI 1H+3",
    description: "Ảnh chính ngang 3:2 + 3 ảnh phụ 1080×1080.",
    platforms: ["linkedin"],
    slots: (w, h, g) => topHeroLayout(w, h, 3 / 2, [1, 1, 1], g),
  },
  {
    id: "li_five_horizontal_square",
    label: "LI 5+ ảnh - ngang + vuông",
    shortLabel: "LI 5+H",
    description: "Ảnh chính ngang 1920×1080 + 3 ảnh phụ 1080×1080.",
    platforms: ["linkedin"],
    slots: (w, h, g) => topHeroLayout(w, h, 16 / 9, [1, 1, 1], g),
  },
  {
    id: "li_five_horizontal_3x2",
    label: "LI 5+ ảnh - ngang opt 2",
    shortLabel: "LI 5+3:2",
    description: "Ảnh chính ngang 2048×1255 + 3 ảnh phụ 3:2.",
    platforms: ["linkedin"],
    slots: (w, h, g) => topHeroLayout(w, h, 2048 / 1255, [3 / 2, 3 / 2, 3 / 2], g),
  },
  {
    id: "two_columns",
    label: "2 split",
    shortLabel: "2",
    description: "Hai ảnh chia đôi dọc.",
    platforms: ["facebook"],
    slots: (w, h, g) => grid(w, h, g, 2, 1, 2),
    legacy: true,
  },
  {
    id: "two_rows",
    label: "2 stacked",
    shortLabel: "2 row",
    description: "Hai ảnh xếp trên dưới.",
    platforms: ["facebook"],
    slots: (w, h, g) => grid(w, h, g, 1, 2, 2),
    legacy: true,
  },
  {
    id: "three_hero_left",
    label: "3 hero left",
    shortLabel: "3L",
    description: "Một ảnh lớn bên trái, hai ảnh nhỏ bên phải.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const heroW = (w - g) * 0.58;
      const sideW = w - heroW - g;
      const sideH = (h - g) / 2;
      return [
        SLOT("slot_1", "Hero", 0, 0, heroW, h),
        SLOT("slot_2", "2", heroW + g, 0, sideW, sideH),
        SLOT("slot_3", "3", heroW + g, sideH + g, sideW, sideH),
      ];
    },
    legacy: true,
  },
  {
    id: "three_hero_top",
    label: "3 hero top",
    shortLabel: "3T",
    description: "Một ảnh ngang phía trên, hai ảnh phía dưới.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const heroH = (h - g) * 0.58;
      const bottomH = h - heroH - g;
      const bottomW = (w - g) / 2;
      return [
        SLOT("slot_1", "Hero", 0, 0, w, heroH),
        SLOT("slot_2", "2", 0, heroH + g, bottomW, bottomH),
        SLOT("slot_3", "3", bottomW + g, heroH + g, bottomW, bottomH),
      ];
    },
    legacy: true,
  },
  {
    id: "four_square",
    label: "4 square grid",
    shortLabel: "4□",
    description: "Bốn ảnh vuông kiểu 2x2.",
    platforms: ["facebook"],
    slots: (w, h, g) => grid(w, h, g, 2, 2, 4),
    legacy: true,
  },
  {
    id: "four_hero_top",
    label: "1 horizontal + 3 square",
    shortLabel: "1+3",
    description: "Một ảnh ngang lớn phía trên, ba ảnh vuông phía dưới.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const heroH = (h - g) * 0.58;
      const rowH = h - heroH - g;
      const cellW = (w - 2 * g) / 3;
      return [
        SLOT("slot_1", "Hero", 0, 0, w, heroH),
        SLOT("slot_2", "2", 0, heroH + g, cellW, rowH),
        SLOT("slot_3", "3", cellW + g, heroH + g, cellW, rowH),
        SLOT("slot_4", "4", 2 * (cellW + g), heroH + g, cellW, rowH),
      ];
    },
    legacy: true,
  },
  {
    id: "five_feature_grid",
    label: "5 feature grid",
    shortLabel: "5",
    description: "Một ảnh lớn và bốn ảnh nhỏ, kiểu post nhiều ảnh.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const heroW = (w - g) * 0.5;
      const sideW = w - heroW - g;
      const cellW = (sideW - g) / 2;
      const cellH = (h - g) / 2;
      return [
        SLOT("slot_1", "Hero", 0, 0, heroW, h),
        SLOT("slot_2", "2", heroW + g, 0, cellW, cellH),
        SLOT("slot_3", "3", heroW + g + cellW + g, 0, cellW, cellH),
        SLOT("slot_4", "4", heroW + g, cellH + g, cellW, cellH),
        SLOT("slot_5", "5", heroW + g + cellW + g, cellH + g, cellW, cellH),
      ];
    },
    legacy: true,
  },
  {
    id: "five_balanced",
    label: "5 balanced grid",
    shortLabel: "5□",
    description: "Năm ảnh dạng grid cân bằng, hợp để soát collage.",
    platforms: ["facebook"],
    slots: (w, h, g) => {
      const topH = (h - g) / 2;
      const bottomH = h - topH - g;
      const topW = (w - 2 * g) / 3;
      const bottomW = (w - g) / 2;
      return [
        SLOT("slot_1", "1", 0, 0, topW, topH),
        SLOT("slot_2", "2", topW + g, 0, topW, topH),
        SLOT("slot_3", "3", 2 * (topW + g), 0, topW, topH),
        SLOT("slot_4", "4", 0, topH + g, bottomW, bottomH),
        SLOT("slot_5", "5", bottomW + g, topH + g, bottomW, bottomH),
      ];
    },
    legacy: true,
  },
  {
    id: "six_grid",
    label: "6 grid",
    shortLabel: "6",
    description: "Sáu ảnh dạng 3x2.",
    platforms: ["facebook"],
    slots: (w, h, g) => grid(w, h, g, 3, 2, 6),
    legacy: true,
  },
];

export function getPostLayout(layoutId: string | undefined, platform: Platform): PostLayoutPreset {
  const available = getAvailablePostLayouts(platform);
  return available.find((layout) => layout.id === layoutId) ??
    POST_LAYOUTS.find((layout) => layout.id === layoutId && (platform === "workspace" ? layout.id === "single" : layout.platforms.includes(platform))) ??
    available[0] ??
    POST_LAYOUTS[0];
}

export function getAvailablePostLayouts(platform: Platform): PostLayoutPreset[] {
  if (platform === "workspace") return POST_LAYOUTS.filter((layout) => layout.id === "single");
  return POST_LAYOUTS.filter((layout) => layout.platforms.includes(platform) && !layout.legacy);
}

export function getLayoutSlotsFor(layoutId: string | undefined, platform: Platform, width: number, height: number): LayoutSlot[] {
  const layout = getPostLayout(layoutId, platform);
  return layout.slots(width, height, gapFor(width, height));
}

export function fitLayersToLayout(ab: Pick<Artboard, "layers" | "layout_id" | "platform" | "width" | "height">): Layer[] {
  const slots = getLayoutSlotsFor(ab.layout_id, ab.platform, ab.width, ab.height);
  const used = new Set<string>();
  return ab.layers.slice(0, slots.length).map((layer, index) => {
    let slot = layer.slot_id ? slots.find((s) => s.id === layer.slot_id && !used.has(s.id)) : undefined;
    if (!slot) slot = slots.find((s) => !used.has(s.id)) ?? slots[Math.min(index, slots.length - 1)];
    used.add(slot.id);
    return {
      ...layer,
      slot_id: slot.id,
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: slot.height,
    };
  });
}

export function firstOpenSlotId(ab: Pick<Artboard, "layers" | "layout_id" | "platform" | "width" | "height">): string {
  const slots = getLayoutSlotsFor(ab.layout_id, ab.platform, ab.width, ab.height);
  const filled = new Set(ab.layers.map((layer) => layer.slot_id).filter(Boolean));
  return slots.find((slot) => !filled.has(slot.id))?.id ?? slots[0]?.id ?? "slot_1";
}
