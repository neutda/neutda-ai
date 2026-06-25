import { config } from "./config.js";
import { pool } from "./pool.js";

const INDEX_PROMPT = `이 이미지를 분석해 한국어로만 답하라.

[이미지 텍스트]
(보이는 모든 글자·숫자·라벨을 가능한 한 정확히 옮겨 적어라. 없으면 "없음")

[이미지 설명]
(사진·도표·UI·인물·장면 등 시각적 내용을 상세히 설명)`;

/**
 * 비전 모델로 이미지 속 텍스트·내용을 추출해 RAG 검색용 텍스트를 만든다.
 * @param {string} dataUrl - data:image/...;base64,... 또는 http URL
 */
export async function describeImageForRag(dataUrl) {
  const { result } = await pool.chat({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: INDEX_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    temperature: 0.2,
    maxTokens: config.defaultMaxTokens,
    enableThinking: false,
    preferredTier: "large",
    allowOtherTiers: false,
  });
  const text = (result.content || "").trim();
  if (!text) throw new Error("이미지에서 텍스트·내용을 추출하지 못했습니다.");
  return text;
}
