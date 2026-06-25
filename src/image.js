import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * content 필드를 OpenAI 호환 image_url 문자열로 정규화한다.
 * 지원 입력:
 *  - http(s) URL        -> 그대로 사용
 *  - data:image/... URI -> 그대로 사용
 *  - 로컬 파일 경로       -> 읽어서 base64 data URI로 변환
 */
export async function toImageUrl(content) {
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("이미지 content는 비어있지 않은 문자열이어야 합니다.");
  }

  const value = content.trim();

  if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) {
    return value;
  }

  const ext = path.extname(value).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`지원하지 않는 이미지 확장자입니다: "${ext || "(없음)"}"`);
  }

  const buffer = await readFile(value);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
