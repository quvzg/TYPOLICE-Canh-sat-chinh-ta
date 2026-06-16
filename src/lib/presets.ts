import type { ArtboardPreset } from "@/types";

export const ARTBOARD_PRESETS: ArtboardPreset[] = [
  { id: "fb_avatar", platform: "facebook", label: "FB Avatar", format: "avatar", layout_id: "single", width: 1000, height: 1000 },
  { id: "fb_cover", platform: "facebook", label: "FB Cover Desktop", format: "cover_desktop", layout_id: "single", width: 1920, height: 1080 },
  { id: "fb_cover_mobile", platform: "facebook", label: "FB Cover Mobile", format: "cover_mobile", layout_id: "single", width: 1920, height: 710 },
  { id: "fb_group_event_cover", platform: "facebook", label: "FB Group/Event Cover", format: "group_event_cover", layout_id: "single", width: 1920, height: 1008 },
  { id: "fb_text_image_single", platform: "facebook", label: "FB Text + 1 Image", format: "text_image_single", layout_id: "single", width: 1440, height: 1440 },
  { id: "fb_text_image_multi", platform: "facebook", label: "FB Text + Multi Image", format: "text_image_multi", layout_id: "fb_text_image_multi", width: 1440, height: 1440 },
  { id: "fb_feed_square", platform: "facebook", label: "FB Single Square", format: "feed_square", layout_id: "single", width: 1200, height: 1200 },
  { id: "fb_feed_vertical", platform: "facebook", label: "FB Single Vertical", format: "feed_vertical", layout_id: "single", width: 960, height: 1200 },
  { id: "fb_feed_landscape", platform: "facebook", label: "FB Single Landscape", format: "feed_landscape", layout_id: "single", width: 1200, height: 800 },
  { id: "fb_two_vertical", platform: "facebook", label: "FB 2 Vertical", format: "two_vertical", layout_id: "fb_two_vertical", width: 1200, height: 1200 },
  { id: "fb_two_landscape", platform: "facebook", label: "FB 2 Landscape", format: "two_landscape", layout_id: "fb_two_landscape", width: 1200, height: 1200 },
  { id: "fb_three_cover_landscape", platform: "facebook", label: "FB 3 Cover Landscape", format: "three_cover_landscape", layout_id: "fb_three_cover_landscape", width: 1920, height: 1920 },
  { id: "fb_three_cover_vertical", platform: "facebook", label: "FB 3 Cover Vertical", format: "three_cover_vertical", layout_id: "fb_three_cover_vertical", width: 1920, height: 1920 },
  { id: "fb_four_square", platform: "facebook", label: "FB 4 Square", format: "four_square", layout_id: "fb_four_square", width: 1920, height: 1920 },
  { id: "fb_four_cover_landscape", platform: "facebook", label: "FB 4 Cover Landscape", format: "four_cover_landscape", layout_id: "fb_four_cover_landscape", width: 1920, height: 1920 },
  { id: "fb_four_cover_vertical", platform: "facebook", label: "FB 4 Cover Vertical", format: "four_cover_vertical", layout_id: "fb_four_cover_vertical", width: 1920, height: 1920 },
  { id: "fb_five_square", platform: "facebook", label: "FB 5+ Square", format: "five_square", layout_id: "fb_five_square", width: 1920, height: 1920 },
  { id: "fb_five_mixed", platform: "facebook", label: "FB 5+ Mixed", format: "five_mixed", layout_id: "fb_five_mixed", width: 1920, height: 1920 },
  { id: "fb_share_link", platform: "facebook", label: "FB Share Link", format: "share_link", layout_id: "single", width: 1200, height: 628 },
  { id: "fb_story", platform: "facebook", label: "FB Story/Reels", format: "story_reels", layout_id: "single", width: 1080, height: 1920 },

  { id: "li_three_horizontal", platform: "linkedin", label: "LI 3 ảnh - chính ngang", format: "three_horizontal", layout_id: "li_three_horizontal", width: 2048, height: 2103 },
  { id: "li_three_vertical", platform: "linkedin", label: "LI 3 ảnh - chính dọc", format: "three_vertical", layout_id: "li_three_vertical", width: 2240, height: 1587 },
  { id: "li_four_vertical_opt1", platform: "linkedin", label: "LI 4 ảnh - dọc opt 1", format: "four_vertical_opt1", layout_id: "li_four_vertical_opt1", width: 1932, height: 1589 },
  { id: "li_four_vertical_opt2", platform: "linkedin", label: "LI 4 ảnh - dọc opt 2", format: "four_vertical_opt2", layout_id: "li_four_vertical_opt2", width: 1830, height: 1935 },
  { id: "li_four_horizontal", platform: "linkedin", label: "LI 4 ảnh - ngang opt 1", format: "four_horizontal", layout_id: "li_four_horizontal", width: 2048, height: 1790 },
  { id: "li_five_horizontal_square", platform: "linkedin", label: "LI 5+ ảnh - ngang + vuông", format: "five_horizontal_square", layout_id: "li_five_horizontal_square", width: 2048, height: 1763 },
  { id: "li_five_horizontal_3x2", platform: "linkedin", label: "LI 5+ ảnh - ngang opt 2", format: "five_horizontal_3x2", layout_id: "li_five_horizontal_3x2", width: 2048, height: 1938 },
  { id: "note_board", platform: "workspace", label: "Note", format: "note", kind: "note", width: 900, height: 620 },
];

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "suggestion", "needs_review"] as const;

export const SEVERITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
  suggestion: "#8b5cf6",
  needs_review: "#6b7280",
};
