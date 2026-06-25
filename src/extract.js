// 업로드된 문서(바이너리 포함)에서 평문 텍스트를 추출한다.
// 지원: pdf, docx, hwpx, hwp(구형), txt/md/csv/json/log 등 텍스트
import zlib from "node:zlib";
import mammoth from "mammoth";
import AdmZip from "adm-zip";
import * as CFB from "cfb";
import { PDFParse } from "pdf-parse";

function ext(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(String(filename || ""));
    return m ? m[1].toLowerCase() : "";
}

// ---- PDF ----------------------------------------------------------------
async function fromPdf(buffer) {
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return result.text || "";
    } finally {
        await parser.destroy().catch(() => {});
    }
}

// ---- DOCX ---------------------------------------------------------------
async function fromDocx(buffer) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value || "";
}

// ---- HWPX (최신 OWPML, zip+xml) -----------------------------------------
function decodeEntities(s) {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
            String.fromCodePoint(parseInt(h, 16)),
        )
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, "&");
}

function fromHwpx(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip
        .getEntries()
        .filter((e) => /Contents\/section\d+\.xml$/i.test(e.entryName))
        .sort((a, b) => a.entryName.localeCompare(b.entryName));
    let text = "";
    for (const e of entries) {
        const xml = e.getData().toString("utf8");
        const stripped = xml
            .replace(/<\/hp:p>/g, "\n")
            .replace(/<[^>]+>/g, "");
        text += decodeEntities(stripped) + "\n";
    }
    return text;
}

// ---- HWP (구형 OLE 복합문서) --------------------------------------------
// PARA_TEXT 레코드(tagId=67)의 UTF-16LE 텍스트만 모아 추출(컨트롤 문자 처리).
function parseParaText(data) {
    let s = "";
    const n = Math.floor(data.length / 2);
    // 8 wchar(16바이트)를 차지하는 확장/인라인 컨트롤 문자
    const extended = new Set([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22,
        23,
    ]);
    let i = 0;
    while (i < n) {
        const code = data.readUInt16LE(i * 2);
        if (code < 32) {
            if (extended.has(code)) {
                i += 8;
            } else {
                if (code === 13 || code === 10) s += "\n";
                i += 1;
            }
        } else {
            s += String.fromCharCode(code);
            i += 1;
        }
    }
    return s;
}

function parseHwpSection(buf) {
    let out = "";
    let pos = 0;
    while (pos + 4 <= buf.length) {
        const header = buf.readUInt32LE(pos);
        pos += 4;
        const tagId = header & 0x3ff;
        let size = (header >> 20) & 0xfff;
        if (size === 0xfff) {
            if (pos + 4 > buf.length) break;
            size = buf.readUInt32LE(pos);
            pos += 4;
        }
        const data = buf.subarray(pos, pos + size);
        pos += size;
        if (tagId === 67) out += parseParaText(data) + "\n"; // HWPTAG_PARA_TEXT
    }
    return out;
}

function fromHwp(buffer) {
    const cfb = CFB.read(buffer, { type: "buffer" });
    const find = (name) => CFB.find(cfb, name) || CFB.find(cfb, "/" + name);

    let compressed = true;
    const fh = find("FileHeader");
    if (fh && fh.content) {
        const h = Buffer.from(fh.content);
        if (h.length >= 40) compressed = (h.readUInt32LE(36) & 1) === 1;
    }

    let text = "";
    for (let i = 0; i < 200; i++) {
        const entry = find(`BodyText/Section${i}`);
        if (!entry || !entry.content) break;
        let data = Buffer.from(entry.content);
        if (compressed) {
            try {
                data = zlib.inflateRawSync(data);
            } catch {
                // 압축이 아닐 수도 있으니 원본 사용
            }
        }
        text += parseHwpSection(data) + "\n";
    }
    return text;
}

// ---- 진입점 -------------------------------------------------------------
export async function extractText(filename, buffer) {
    const e = ext(filename);
    switch (e) {
        case "pdf":
            return fromPdf(buffer);
        case "docx":
            return fromDocx(buffer);
        case "hwpx":
            return fromHwpx(buffer);
        case "hwp":
            return fromHwp(buffer);
        case "doc":
            throw new Error(
                "구형 .doc 형식은 지원하지 않습니다. .docx / PDF 로 변환 후 업로드하세요.",
            );
        default:
            // 텍스트 계열로 간주
            return buffer.toString("utf8");
    }
}

export const SUPPORTED_EXT = [
    "pdf",
    "docx",
    "hwpx",
    "hwp",
    "txt",
    "md",
    "csv",
    "json",
    "log",
];
