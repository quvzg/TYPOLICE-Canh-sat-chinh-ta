import assert from "node:assert/strict";
import { runRuleChecker } from "../src/lib/qa/ruleChecker";
import { validateLLMIssues } from "../src/lib/qa/issueMerger";
import { protectedTermsFromBrandKit } from "../src/lib/qa/protectedText";
import {
  applyDeterministicOcrVisualRoles,
  applyVisionOcrVisualRoles,
  isVisualCheckableOcrBox,
} from "../src/lib/qa/visualTextFilter";
import type { BrandKit, Issue, OcrBox } from "../src/types";

const brandKit: BrandKit = {
  brand_terms: [
    "GreenNode",
    "AI Agent",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
  ],
  protected_terms: [
    "GreenNode",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
  ],
  allowed_hashtags: ["#LifeatVNG"],
  preferred_spellings: {},
  product_terms: {
    "green node": "GreenNode",
    "vng games": "VNGGames",
    ZaloPay: "Zalopay",
    zalopay: "Zalopay",
  },
  risky_words: {},
  preferred_wording: {},
  cta_rules: { preferred: [], avoid: { "đừng bỏ lỡ": "Tìm hiểu thêm" } },
  missing_tone_map: {},
  wrong_tone_map: {},
  ambiguous_words: {},
  do_not_change: [
    "VNGCampus",
    "LinkedIn",
    "YouTube",
    "TikTok",
    "GreenNode",
    "Zalopay",
    "Life at VNG",
    "Life at VNGGames",
    "Life at Zalopay",
  ],
};

function issuesFor(text: string): Issue[] {
  return runRuleChecker(text, brandKit, {
    source_type: "image",
    source_id: "test_source",
    box_id: "box_test",
    artboard_id: "artboard_test",
  });
}

function hasIssue(text: string, original: string, suggestion: string): boolean {
  return issuesFor(text).some((issue) => issue.original === original && issue.suggestion === suggestion);
}

function originals(text: string): string[] {
  return issuesFor(text).map((issue) => issue.original);
}

assert.equal(issuesFor("Chờ chút nhé...").length, 0, "valid ellipsis must not be flagged");
assert.ok(hasIssue("Đang cập nhật.... Vui lòng chờ...", "....", "..."), "4+ dots should become ellipsis");
assert.ok(hasIssue("Chờ mình chút . . . sắp có thông báo mới!", ". . .", "..."), "spaced ellipsis should become compact ellipsis");
assert.equal(issuesFor("Tuyệt! 🥳").length, 0, "emoji after punctuation with a space should be valid");
assert.ok(hasIssue("Tuyệt!🥳", "!🥳", "! 🥳"), "emoji after punctuation should require a space");
assert.ok(hasIssue("Tuyệt!  🥳", "!  🥳", "! 🥳"), "emoji after punctuation should allow only one space");
assert.ok(hasIssue("Tuyệt!   🥳", "!   🥳", "! 🥳"), "extra spaces before emoji should be collapsed to one");
assert.ok(hasIssue("Tuyệt🔥", "t🔥", "t 🔥"), "emoji after text should still require a space");
assert.equal(
  issuesFor("Theo dõi #RandomCampaign ngay.").filter((issue) => issue.type === "hashtag").length,
  0,
  "valid hashtag outside legacy allowed list must not be flagged"
);
assert.ok(
  hasIssue("Theo dõi # VNG ngay.", "# VNG", "#VNG"),
  "hashtag space after # should still be fixed"
);

assert.ok(
  hasIssue("Ưu đãi đặc biệt ( chỉ hôm nay ) - đừng bỏ lỡ!", "( c", "(c"),
  "space after opening bracket should be removed"
);
assert.ok(
  hasIssue("Ưu đãi đặc biệt ( chỉ hôm nay ) - đừng bỏ lỡ!", "y )", "y)"),
  "space before closing bracket should be removed"
);
assert.ok(
  hasIssue("Ưu đãi giảm giá (50% tất cả sản phẩm mùa hè.", ".", ")."),
  "unmatched opening bracket should insert closing bracket before final punctuation"
);

assert.ok(
  hasIssue(
    "Ngày 10/06 vừa qua, LifeatVNGGames đã mở màn bằng buổi đào tạo tại VNGCampus.",
    "LifeatVNGGames",
    "Life at VNGGames"
  ),
  "CamelCase collision should use canonical protected phrase"
);
assert.ok(!originals("Ngày hội diễn ra tại VNGCampus.").includes("VNGCampus"), "intentional CamelCase exclusions should not be flagged");
assert.ok(!originals("GreenNode đã sẵn sàng.").includes("GreenNode"), "canonical GreenNode must not be flagged");
assert.ok(hasIssue("Green Node đã sẵn sàng.", "Green Node", "GreenNode"), "GreenNode separated spelling should be corrected");
assert.ok(hasIssue("Chương trình AIAgent đang được triển khai.", "AIAgent", "AI Agent"), "merged acronym should split");
assert.ok(!originals("Sản phẩm VNGGames ra mắt tính năng mới.").includes("VNGGames"), "canonical product term must not be split after acronym");
assert.ok(hasIssue("Sản phẩm VNG Games ra mắt tính năng mới.", "VNG Games", "VNGGames"), "wrong product spacing should still be corrected");
assert.ok(!originals("Thanh toán bằng Zalopay thật tiện.").includes("Zalopay"), "canonical Zalopay casing must not be flagged");
assert.ok(hasIssue("Thanh toán bằng ZaloPay thật tiện.", "ZaloPay", "Zalopay"), "ZaloPay should be corrected to Zalopay");
assert.equal(issuesFor("Khám phá Life at VNG mỗi ngày.").length, 0, "Life at VNG must be treated as a correct protected phrase");
assert.equal(issuesFor("Khám phá Life at VNGGames mỗi ngày.").length, 0, "Life at VNGGames must be treated as a correct protected phrase");
assert.equal(issuesFor("Khám phá Life at Zalopay mỗi ngày.").length, 0, "Life at Zalopay must be treated as a correct protected phrase");
assert.equal(issuesFor("Đừng bỏ lỡ chương trình này.").length, 0, "CTA wording rules are intentionally disabled");

assert.equal(issuesFor("Sản phẩm tốt nhưng giá hơi cao.").length, 0, "missing comma before conjunction is intentionally not deterministic");
assert.equal(issuesFor("Opening hours: thứ 2-6, 9h-21h.").filter((issue) => issue.original.includes("2-6")).length, 0, "dash type should not be deterministic");
assert.equal(issuesFor("\"Ưu đãi\" dịp này.").length, 0, "straight quote style should not be flagged");

function validateCaption(text: string, candidates: Partial<Issue>[]): Issue[] {
  return validateLLMIssues(
    text,
    candidates.map((candidate) => ({
      source_type: "caption",
      source_id: "caption_test",
      artboard_id: null,
      created_by: "llm_caption_qa",
      confidence: 0.8,
      is_definite_error: false,
      ...candidate,
    })),
    protectedTermsFromBrandKit(brandKit)
  );
}

assert.equal(
  validateCaption("SIÊU SALE MÙA HÈ\nƯu đãi mở bán hôm nay.", [{
    type: "style",
    severity: "low",
    original: "SIÊU SALE MÙA HÈ",
    suggestion: "Siêu sale mùa hè",
    reason: "Không cần viết hoa toàn bộ.",
  }]).length,
  0,
  "all-caps initial caption heading must not be treated as a capitalization/style issue"
);

assert.equal(
  validateCaption("Mở bán hôm nay.\nSIÊU SALE MÙA HÈ", [{
    type: "style",
    severity: "low",
    original: "SIÊU SALE MÙA HÈ",
    suggestion: "Siêu sale mùa hè",
    reason: "Không cần viết hoa toàn bộ.",
  }]).length,
  1,
  "all-caps exemption should only apply to the initial caption heading"
);

assert.equal(
  validateCaption("CHỈNH CHU CÙNG TEAM\nƯu đãi hôm nay.", [{
    type: "spelling",
    severity: "high",
    original: "CHỈNH CHU",
    suggestion: "CHỈN CHU",
    reason: "Sai chính tả tiếng Việt.",
    is_definite_error: true,
  }]).length,
  1,
  "real spelling errors inside an all-caps heading must still be kept"
);

assert.equal(
  validateCaption("Khám phá Life at VNGGames mỗi ngày.", [{
    type: "brand_term",
    severity: "high",
    original: "Life at VNGGames",
    suggestion: "Life at VNG Games",
    reason: "Tách tên campaign cho dễ đọc.",
  }]).length,
  0,
  "LLM candidates must not change protected Life at VNGGames phrase"
);

assert.equal(
  validateCaption("Khám phá Life at Zalopay mỗi ngày.", [{
    type: "brand_term",
    severity: "high",
    original: "Life at Zalopay",
    suggestion: "Life at ZaloPay",
    reason: "Đổi casing theo brand.",
  }]).length,
  0,
  "LLM candidates must not change protected Life at Zalopay phrase"
);

assert.equal(
  validateCaption("AI Agent đã sẵn sàng.", [{
    type: "spelling",
    severity: "high",
    original: "AI Agent",
    suggestion: "AI-Agent",
    reason: "Sửa chính tả cụm từ.",
  }]).length,
  0,
  "LLM candidates must not change brand guideline terms outside do_not_change"
);

assert.equal(
  validateCaption("Xem https://sucess.com/offical ngay.", [{
    type: "spelling",
    severity: "high",
    original: "sucess",
    suggestion: "success",
    reason: "Sai chính tả tiếng Anh.",
  }]).length,
  0,
  "LLM candidates must not spell-correct text inside links"
);

assert.ok(hasIssue("🔍Hình thức tham gia: Cá nhân", "🔍", "🔍 "), "emoji bullets at line start should require a following space");
assert.ok(hasIssue("-Nội dung chính", "-", "- "), "plain bullets should require a following space");
assert.ok(hasIssue("1.Nội dung chính", "1.", "1. "), "numbered list markers should require a following space");

assert.ok(hasIssue("Thời gian 09:00", " ", ": "), "likely field labels should suggest a colon before the value");
assert.ok(hasIssue("Địa điểm, VNG Campus", "Địa điểm, VNG Campus", "Địa điểm: VNG Campus"), "field label comma should become colon");
assert.ok(hasIssue("Thời gian : 09:00", "Thời gian : 09:00", "Thời gian: 09:00"), "extra space before field label colon should be removed");
assert.ok(hasIssue("Hình thức tham gia| Cá nhân", "Hình thức tham gia| Cá nhân", "Hình thức tham gia: Cá nhân"), "OCR pipe after field label should be reviewed as colon");

assert.ok(hasIssue("1. Một\n2) Hai", "2)", "2."), "mixed numbered delimiters should be normalized");
assert.ok(hasIssue("- Một\n• Hai", "•", "-"), "mixed bullet markers should be normalized");
assert.ok(hasIssue("CTY ABC TUYỂN DỤNG\nCông ty có nhiều vị trí mới.", "CTY", "Công ty"), "heading abbreviation should be normalized when full form also appears");
assert.ok(hasIssue("Đăng ký hôm nay\nĐiền form đk tại link bên dưới.", "đk", "đăng ký"), "mixed đăng ký abbreviation should be normalized");
assert.ok(hasIssue("Theo dõi FB và Facebook để cập nhật tin mới.", "FB", "Facebook"), "mixed social platform abbreviations should be normalized");
assert.ok(hasIssue("Sự kiện tại TPHCM\nĐịa điểm ở TP.HCM sẽ gửi sau.", "TPHCM", "TP.HCM"), "mixed TP.HCM variants should be normalized");
assert.equal(
  issuesFor("CTY ABC TUYỂN DỤNG\nNộp CV hôm nay.").filter((issue) => issue.reason.includes("không đồng bộ")).length,
  0,
  "single-form abbreviations should not be flagged as inconsistent"
);
assert.equal(
  issuesFor("Xem https://cty.com và thông tin công ty.").filter((issue) => issue.original === "cty").length,
  0,
  "abbreviations inside links must not be normalized"
);
assert.ok(hasIssue("Ưu đãi đặc biệt\nƯu đãi đặc biệt", "Ưu đãi đặc biệt", ""), "duplicate full lines should be removable");
assert.ok(hasIssue("Ưu đãi đặc biệt ưu đãi đặc biệt hôm nay.", "Ưu đãi đặc biệt ưu đãi đặc biệt", "Ưu đãi đặc biệt"), "duplicate phrases should be removable");
assert.ok(hasIssue("**Ưu đãi** hôm nay", "**Ưu đãi**", "Ưu đãi"), "leaked markdown bold should be removed");
assert.ok(hasIssue("Xem [link](https://vng.com.vn)", "[link](https://vng.com.vn)", "link: https://vng.com.vn"), "leaked markdown links should be flattened");
assert.ok(hasIssue("VNG &amp; bạn", "&amp;", "&"), "HTML entities should be decoded");
assert.ok(hasIssue("Một\n\n\nHai", "\n\n\n", "\n\n"), "too many blank lines should be collapsed");
assert.ok(hasIssue("  Nội dung", "  ", ""), "leading line spaces should be removed");
assert.ok(hasIssue("Nội dung  ", "  ", ""), "trailing line spaces should be removed");
assert.ok(hasIssue("Nội dung\n---\nTiếp tục", "---", ""), "paste separator lines should be removable");

assert.ok(hasIssue("#VNG #LifeatVNG #VNG", "#VNG", ""), "duplicate hashtags should be removable");
assert.ok(hasIssue("#Life-at-VNG", "#Life-at-VNG", "#LifeatVNG"), "hyphenated hashtags should be compacted");
assert.ok(hasIssue("Tham gia cùng#VNG", "g#VNG", "g #VNG"), "hashtag stuck to previous text should get a space");
assert.ok(hasIssue("Tag @ VNG ngay", "@ VNG", "@VNG"), "mentions should not have a space after @");
assert.ok(hasIssue("Tag @VNG Games ngay", "@VNG Games", "@VNGGames"), "brand mentions should not contain spaces");
assert.ok(hasIssue("Mail test @gmail.com", "test @gmail.com", "test@gmail.com"), "split email before @ should be joined");
assert.ok(hasIssue("Vào https:// vng.com.vn", "https:// vng.com.vn", "https://vng.com.vn"), "split URL scheme should be joined");
assert.ok(hasIssue("Vào https://vng.com.vn.", "https://vng.com.vn.", "https://vng.com.vn"), "URL trailing punctuation should be a review issue");

assert.ok(hasIssue("Giảm 50 % hôm nay", "50 %", "50%"), "percent signs should be attached to numbers");
assert.ok(hasIssue("Voucher 100 k", "100 k", "100k"), "currency shorthand spacing should be normalized");
assert.ok(hasIssue("Dung lượng 5gb", "5gb", "5 GB"), "data units should normalize spacing and casing");
assert.ok(hasIssue("Ngân sách 1,000,000", "1,000,000", "1.000.000"), "Vietnamese thousands separators should use dots");
assert.ok(hasIssue("09:00-11:00", "09:00-11:00", "09:00 - 11:00"), "time ranges should use spaced hyphen");
assert.ok(hasIssue("Ngày 32/13/2026", "32/13/2026", "32/13/2026"), "impossible dates should require review");
assert.ok(hasIssue("Bắt đầu 25:90", "25:90", "25:90"), "impossible times should require review");
assert.ok(hasIssue("Thứ hai, 16/06/2026", "Thứ hai, 16/06/2026", "Thứ hai, 16/06/2026"), "weekday/date mismatch should require review");
assert.ok(hasIssue("Sự kiện diễn ra hôm nay", "hôm nay", "hôm nay"), "relative dates should require review");
assert.ok(hasIssue("Hotline 012345678", "012345678", "012345678"), "unusual phone lengths should require review");

assert.ok(hasIssue("Thanh toán bằng Zal0pay", "Zal0pay", "Zalopay"), "OCR zero in Zalopay should be corrected");
assert.ok(hasIssue("GreenN0de challenge", "GreenN0de", "GreenNode"), "OCR zero in GreenNode should be corrected");
assert.ok(hasIssue("Thờigian 09:00", "Thờigian", "thời gian"), "common OCR joined words should be corrected");
assert.ok(hasIssue("Chào Typolice", "à", "à"), "combining Vietnamese marks should be normalized");
assert.ok(hasIssue("Top10 đội thi GenZ", "Top10", "Top 10"), "Top plus number should be spaced");
assert.ok(hasIssue("Top10 đội thi GenZ", "GenZ", "Gen Z"), "Gen Z should be spaced");
assert.ok(hasIssue("O Hình thức tham gia", "O ", ""), "OCR icon-like leading characters should require review");
assert.equal(
  issuesFor("Đối tượng tham gia Tất cả Starter Hình thức tham gia Cá nhân")
    .filter((issue) => issue.reason.includes("gộp hai dòng")).length,
  0,
  "OCR merged field-label warning is too noisy and should stay out of issue results"
);

assert.ok(hasIssue("Một trãi nghiệm mới", "trãi nghiệm", "trải nghiệm"), "safe Vietnamese contextual typo should be fixed");
assert.ok(hasIssue("Ưu đải hôm nay", "Ưu đải", "ưu đãi"), "Vietnamese typo ưu đải should be fixed");
assert.ok(hasIssue("Khuyến mải lớn", "Khuyến mải", "khuyến mãi"), "Vietnamese typo khuyến mải should be fixed");
assert.ok(hasIssue("Registeration sucess offical", "Registeration", "registration"), "English typo registration should be fixed");
assert.ok(hasIssue("Registeration sucess offical", "sucess", "success"), "English typo success should be fixed");
assert.ok(hasIssue("Registeration sucess offical", "offical", "official"), "English typo official should be fixed");
assert.equal(issuesFor("Xem https://sucess.com/offical ngay.").filter((issue) => ["sucess", "offical"].includes(issue.original)).length, 0, "URL text must not be spell-corrected");
assert.ok(hasIssue("PM sẽ gửi brief", "PM", "PM"), "unexplained internal acronyms should require review");

function ocrBox(text: string, confidence = 0.9): OcrBox {
  return {
    box_id: `box_${text.replace(/\W+/g, "_")}`,
    asset_id: "asset_test",
    text,
    confidence,
    bbox: [0, 0, 120, 40],
  };
}

const [standaloneLogo] = applyDeterministicOcrVisualRoles([ocrBox("VNGGames")], brandKit);
assert.equal(standaloneLogo.visual_role, "logo_wordmark", "standalone type logos should be classified as logo_wordmark");
assert.equal(isVisualCheckableOcrBox(standaloneLogo), false, "standalone type logos should be skipped from image text QA");

const [posterText] = applyDeterministicOcrVisualRoles([ocrBox("Đăng ký tham gia trước 16/06")], brandKit);
assert.equal(posterText.visual_role, "graphic_text", "poster copy should be classified as graphic_text");
assert.equal(isVisualCheckableOcrBox(posterText), true, "poster copy should be checked like caption text");

const [lowConfidenceText] = applyDeterministicOcrVisualRoles([ocrBox("Footer nhỏ nhưng đọc được", 0.52)], brandKit);
assert.equal(lowConfidenceText.visual_role, "unknown", "uncertain readable text should be strict unknown");
assert.equal(isVisualCheckableOcrBox(lowConfidenceText), true, "unknown visual text should still be checked");

const [visionUnknown] = applyVisionOcrVisualRoles([posterText], [{
  box_id: posterText.box_id,
  role: "unknown",
  should_check: false,
  confidence: 0.4,
  reason: "Không chắc vùng chữ.",
}]);
assert.equal(isVisualCheckableOcrBox(visionUnknown), true, "unknown model classifications should remain checkable");

const [visionDecoration] = applyVisionOcrVisualRoles([posterText], [{
  box_id: posterText.box_id,
  role: "decorative_text",
  should_check: true,
  confidence: 0.86,
  reason: "Chữ trang trí.",
}]);
assert.equal(isVisualCheckableOcrBox(visionDecoration), false, "decorative model classifications should be skipped");

console.log("ruleChecker regression tests passed");
