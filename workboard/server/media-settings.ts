import type { Env } from "./env";
import { HttpError } from "./http";
import {
  DEFAULT_MEDIA_SETTINGS,
  IMAGE_MODEL_CHOICES,
  MEDIA_SOURCE_PRESETS,
  type MediaSettings,
} from "../shared/media-policy";
export function normalizeMediaSettings(input: any): MediaSettings {
  const preset = MEDIA_SOURCE_PRESETS.find(
    (p) => Array.isArray(input?.sources) && p.id === input.sources.join(","),
  );
  if (
    !preset ||
    typeof input.art_direction !== "boolean" ||
    ![input.image_model, input.corrective_image_model].every(
      (id) => typeof id === "string" && Object.hasOwn(IMAGE_MODEL_CHOICES, id),
    )
  )
    throw new HttpError(400, "이미지 수급 방식과 모델을 확인하세요.");
  return {
    sources: preset.sources,
    art_direction: input.art_direction,
    image_model: input.image_model,
    corrective_image_model: input.corrective_image_model,
  };
}
/** The defaults apply until the operator saves, including before migration 0016 exists. */
export async function mediaSettings(env: Env): Promise<MediaSettings> {
  try {
    const row = await env.WORKBOARD_DB.prepare(
      "SELECT sources,art_direction,image_model,corrective_image_model FROM media_settings WHERE id=1",
    ).first<{ sources: string; art_direction: number; image_model: string; corrective_image_model: string }>();
    if (!row) return DEFAULT_MEDIA_SETTINGS;
    return normalizeMediaSettings({
      sources: JSON.parse(row.sources),
      art_direction: row.art_direction === 1,
      image_model: row.image_model,
      corrective_image_model: row.corrective_image_model,
    });
  } catch {
    return DEFAULT_MEDIA_SETTINGS;
  }
}
/** When generation is enabled, its image models must be listed for this Gemini key (null: the list could not be read). */
export async function saveMediaSettings(env: Env, input: unknown, availableIds: string[] | null) {
  const settings = normalizeMediaSettings(input);
  if (settings.sources.includes("generate") && !availableIds)
    throw new HttpError(409, "Gemini API 연결을 확인하지 못해 이미지 생성 설정을 저장하지 않았습니다.");
  if (settings.sources.includes("generate"))
    for (const id of new Set([settings.image_model, settings.corrective_image_model]))
      if (!availableIds!.some((x) => x === id || x.startsWith(id + "-")))
        throw new HttpError(409, `${IMAGE_MODEL_CHOICES[id].label}을 이 Gemini API 키에서 사용할 수 있는지 확인하지 못했습니다.`);
  try {
    await env.WORKBOARD_DB.prepare(
      "INSERT INTO media_settings(id,sources,art_direction,image_model,corrective_image_model,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sources=excluded.sources,art_direction=excluded.art_direction,image_model=excluded.image_model,corrective_image_model=excluded.corrective_image_model,updated_at=excluded.updated_at",
    )
      .bind(
        JSON.stringify(settings.sources),
        settings.art_direction ? 1 : 0,
        settings.image_model,
        settings.corrective_image_model,
        new Date().toISOString(),
      )
      .run();
  } catch {
    throw new HttpError(503, "이미지 수급 설정을 저장할 D1 테이블이 없습니다. 마이그레이션 0016을 적용하세요.");
  }
  return settings;
}
