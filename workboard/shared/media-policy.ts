export const VISUAL_POLICY = "korea-topic-photographic-v3";
/** Fresh image batches an operator may request after the automatic ladder is spent. */
export const OPERATOR_MEDIA_ROUNDS = 2;
/** Gemini image models the operator may select, with paid-tier rates in USD (per 1M tokens, or per 1K image). */
export const IMAGE_MODEL_CHOICES = {
  "gemini-nano-banana-2.1": { label: "Nano Banana 2.1", input: 1.5, text: 7.5, image: 30, per_image: 0.0336 },
  "gemini-3-pro-image": { label: "Nano Banana Pro", input: 2, text: 12, image: 120, per_image: 0.134 },
  "gemini-3.1-flash-image": { label: "Nano Banana 2 (이전 세대)", input: 0.5, text: 3, image: 60, per_image: 0.067 },
} as const;
export type ImageModelId = keyof typeof IMAGE_MODEL_CHOICES;
/**
 * Where a missing photo comes from, after registered licensed originals:
 * "commons" is a Claude-planned Wikimedia Commons search of real, openly
 * licensed photographs; "generate" is a Claude-directed generated illustration.
 */
export type MediaSource = "commons" | "generate";
export const MEDIA_SOURCE_PRESETS: { id: string; sources: MediaSource[]; label: string }[] = [
  { id: "commons,generate", sources: ["commons", "generate"], label: "Claude 실제 사진 검색 → Claude 연출 생성 (권장)" },
  { id: "generate,commons", sources: ["generate", "commons"], label: "Claude 연출 생성 → Claude 실제 사진 검색" },
  { id: "generate", sources: ["generate"], label: "Claude 연출 생성만" },
  { id: "commons", sources: ["commons"], label: "Claude 실제 사진 검색만 (생성하지 않음)" },
];
export type MediaSettings = {
  sources: MediaSource[];
  /** Claude writes the concrete scene and search phrases for each image slot. */
  art_direction: boolean;
  /** Model for the first candidates of each slot. */
  image_model: ImageModelId;
  /** Model for the corrective batch and the targeted pixel edit after rejections. */
  corrective_image_model: ImageModelId;
};
export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  sources: ["commons", "generate"],
  art_direction: true,
  image_model: "gemini-nano-banana-2.1",
  corrective_image_model: "gemini-3-pro-image",
};
