/**
 * API 법칙: 모델 출력을 JSON 계약으로 강제한다.
 * 역할(특기)과 달리 라우팅이 아니라 /api/ask 응답 형식 가드.
 */
import { seoulToday, isDateKey, isStartKey, isEndKey } from "./koreanDate.js";

function compact(s) {
    return String(s ?? "")
        .toLowerCase()
        .replace(/\s+/g, "");
}

export function schemaKeys(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
    return Object.keys(schema)
        .map((k) => String(k).trim())
        .filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
        .slice(0, 16);
}

export function emptyFromSchema(schema) {
    const out = {};
    for (const k of schemaKeys(schema)) out[k] = "";
    return out;
}

export function matchesRule(question, rule) {
    if (!rule || rule.enabled === false) return false;
    const q = compact(question);
    if (!q) return false;
    const kws = Array.isArray(rule.keywords) ? rule.keywords : [];
    const needles = kws.map(compact).filter((k) => k.length >= 2);
    if (!needles.length) return false;
    return needles.some((k) => q.includes(k));
}

/** 키에 묶인 법칙 중 질문과 맞는 첫 번째 (키워드 확정) */
export function matchBoundRule(question, rules) {
    if (!Array.isArray(rules)) return null;
    for (const r of rules) {
        if (matchesRule(question, r)) return r;
    }
    return null;
}

function ruleIntentLine(rule) {
    const intent = String(rule.intent ?? "").trim();
    if (intent) return intent;
    return `${rule.name}에 해당하는 요청·진술. 사용자가 결과 이름을 말할 필요는 없다.`;
}

/** 키워드가 없어도 의도로 고르기 위한 분류 프롬프트 */
export function buildIntentClassifyMessages(question, rules) {
    const list = (Array.isArray(rules) ? rules : [])
        .filter((r) => r && r.enabled !== false)
        .map((r, i) => {
            const kws = (r.keywords || []).join(", ");
            const kwPart = kws ? `\n   힌트 단어(없어도 됨): ${kws}` : "";
            return `${i + 1}) id=${r.id}\n   이름: ${r.name}\n   의도: ${ruleIntentLine(r)}${kwPart}`;
        })
        .join("\n");
    return [
        {
            role: "system",
            content:
                "너는 의도 분류기다. 현재 사용자 말이 아래 결과 형식 중 하나에 해당하면 그 id만, 아니면 none을 출력하라. " +
                "JSON 객체만 출력하라. 설명·마크다운·코드블록 금지. 첫 글자는 { 이어야 한다.\n" +
                '형식: {"id":"형식id"} 또는 {"id":"none"}\n' +
                "규칙:\n" +
                "- 각 항목의 이름·의도 설명을 기준으로 고른다. 사용자가 이름을 말할 필요는 없다.\n" +
                "- 규정·절차·방법을 묻는 질문, 순수 인사, 다른 주제는 none.\n" +
                "- 애매하면 none.",
        },
        {
            role: "user",
            content: `결과 형식:\n${list}\n\n현재 말:\n${String(question ?? "")}`,
        },
    ];
}

/** 분류 모델 출력 → 법칙 또는 null */
export function parseIntentClassify(text, rules) {
    const list = Array.isArray(rules) ? rules.filter((r) => r && r.enabled !== false) : [];
    if (!list.length) return null;
    const obj = sliceJsonObject(text);
    const raw = String(obj?.id ?? obj?.rule ?? obj?.name ?? "").trim();
    if (!raw || /^none|null|0$/i.test(raw)) return null;
    const byId = list.find((r) => r.id === raw);
    if (byId) return byId;
    const needle = compact(raw);
    return list.find((r) => compact(r.name) === needle) || null;
}

export function buildJsonRuleMessages(question, rule, ragContext = "") {
    const keys = schemaKeys(rule.schema);
    const today = seoulToday();
    const fields = keys
        .map((k) => `- ${k}: ${fieldHint(k, rule.schema)}`)
        .join("\n");
    const extra =
        typeof rule.instruction === "string" && rule.instruction.trim()
            ? `\n추가 지시: ${rule.instruction.trim()}`
            : "";
    const dateKeys = keys.filter(isDateKey);
    const dateRule = dateKeys.length
        ? `\n오늘(Asia/Seoul): ${today.ymd} (${today.wd}). ` +
          `날짜로 보이는 필드(${dateKeys.join(", ")})는 YYYY-MM-DD 로 채워라. ` +
          "내일/다음주/요일 같은 상대 표현은 오늘을 기준으로 환산하라. " +
          "시작·종료가 둘 다 있고 하루만 언급되면 같은 날짜를 넣어라."
        : "";
    const sys =
        "너는 정보 추출기다. 주어진 스키마 키만 갖는 JSON 객체 단 하나를 출력하라. " +
        "설명·인사·마크다운·코드블록·주석은 쓰지 마라. 첫 글자는 { 이어야 한다.\n" +
        "필드 설명의 힌트는 형식 참고일 뿐, 힌트 문구를 그대로 복사하지 마라. " +
        "사용자 말에서 각 키에 해당하는 값을 채워라. 정말 없으면 빈 문자열." +
        dateRule +
        extra +
        `\n스키마 필드:\n${fields}`;
    const q = String(question ?? "");
    const ctx = String(ragContext ?? "").trim();
    const todayLine = dateKeys.length ? `오늘: ${today.ymd} (${today.wd})\n` : "";
    const user = ctx
        ? `${todayLine}참고 문서:\n${ctx.slice(0, 4000)}\n\n사용자 말:\n${q}\n\n스키마 JSON만 출력하라.`
        : `${todayLine}사용자 말:\n${q}\n\n스키마 JSON만 출력하라.`;
    return [
        { role: "system", content: sys },
        { role: "user", content: user },
    ];
}

export function retryJsonRuleMessages(question, rule, prev, ragContext = "") {
    const base = buildJsonRuleMessages(question, rule, ragContext);
    base[0].content +=
        "\n이전 출력이 잘못됐다. 빈 문자열을 복사하지 말고, 사용자 말의 정보를 채워 JSON 객체만 출력하라.";
    base.push({
        role: "user",
        content:
            `이전 출력:\n${String(prev || "").slice(0, 800)}\n\n` +
            `사용자 말:\n${String(question ?? "")}\n\n` +
            `위 말에서 값을 채워 스키마 JSON만 다시 내라. 빈 값 복사는 오답이다.`,
    });
    return base;
}

function fieldHint(key, schema) {
    const hint = schema?.[key];
    if (typeof hint === "string" && hint.trim()) return hint.trim();
    if (isDateKey(key)) {
        if (isEndKey(key)) return "종료일, YYYY-MM-DD";
        if (isStartKey(key)) return "시작일, YYYY-MM-DD";
        return "날짜, YYYY-MM-DD";
    }
    return `${key} 값`;
}

const KEY_ALIASES = {
    title: ["title", "제목", "타이틀", "name", "subject", "summary"],
    desc: [
        "desc",
        "description",
        "내용",
        "설명",
        "상세",
        "detail",
        "body",
        "memo",
        "note",
    ],
};

function lookupValue(obj, key) {
    if (obj[key] != null && String(obj[key]).trim() !== "") return obj[key];
    const aliases = KEY_ALIASES[key] || [key];
    const lower = Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v]),
    );
    for (const a of aliases) {
        const v = obj[a] ?? lower[String(a).toLowerCase()];
        if (v != null && String(v).trim() !== "") return v;
    }
    return obj[key];
}

export function isBlankRuleData(data) {
    if (!data || typeof data !== "object") return true;
    const vals = Object.values(data);
    if (!vals.length) return true;
    return vals.every((v) => String(v ?? "").trim() === "");
}

function sliceJsonObject(text) {
    const t = String(text ?? "").trim();
    if (!t) return null;
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : t;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const slice = body.slice(start, end + 1);
    try {
        return JSON.parse(slice);
    } catch {
        try {
            return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
        } catch {
            return null;
        }
    }
}

export function coerceToSchema(obj, schema) {
    const out = emptyFromSchema(schema);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
    for (const k of Object.keys(out)) {
        const v = lookupValue(obj, k);
        if (v == null) out[k] = "";
        else if (typeof v === "object") out[k] = JSON.stringify(v);
        else out[k] = String(v);
    }
    return out;
}

/**
 * 모델 원문 → 스키마 객체.
 * @returns {{ ok: boolean, data: object }}
 */
export function parseRuleOutput(text, schema) {
    const parsed = sliceJsonObject(text);
    if (!parsed) return { ok: false, data: emptyFromSchema(schema) };
    return { ok: true, data: coerceToSchema(parsed, schema) };
}

/**
 * 호출자가 넘긴 rule/schema JSON → 일회성 법칙.
 * { schema, name?, instruction?, skipRag? } 또는 스키마 객체 자체.
 */
export function parseCallerRule(input) {
    let obj = input;
    if (typeof input === "string") {
        const t = input.trim();
        if (!t) return null;
        try {
            obj = JSON.parse(t);
        } catch {
            throw new Error("rule/schema JSON이 올바르지 않습니다.");
        }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        throw new Error("rule/schema JSON이 올바르지 않습니다.");
    }
    const looksLikeRule = obj.schema != null && typeof obj.schema === "object";
    const schema = looksLikeRule ? obj.schema : obj;
    const keys = schemaKeys(schema);
    if (!keys.length) {
        throw new Error(
            '스키마에 사용할 필드가 없습니다. 예: {"status":"","memo":""}',
        );
    }
    const outSchema = {};
    for (const k of keys) {
        const v = schema[k];
        outSchema[k] = typeof v === "string" ? v.slice(0, 80) : "";
    }
    const name = String((looksLikeRule ? obj.name : "") || "커스텀")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60) || "커스텀";
    return {
        id: "custom",
        name,
        enabled: true,
        keywords: [],
        schema: outSchema,
        intent: String((looksLikeRule ? obj.intent : "") || "")
            .trim()
            .slice(0, 400),
        instruction: String((looksLikeRule ? obj.instruction : "") || "")
            .trim()
            .slice(0, 400),
        skipRag: looksLikeRule ? obj.skipRag !== false : true,
        custom: true,
    };
}
