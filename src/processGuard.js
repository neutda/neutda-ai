/**
 * 관리서버/에이전트가 "로그만 안 남기고" 죽는 경우를 막는다.
 *
 * 흔한 원인:
 *  - 처리되지 않은 Promise 거부 (async 라우트, setInterval 의 async 콜백)
 *  - 클라이언트 끊긴 뒤 SSE/HTTP write → EPIPE/ECONNRESET (응답 객체 error 미처리)
 *  - Node 18+ 기본 requestTimeout 5분 → 긴 스트리밍이 끊기며 후속 write 가 프로세스 종료
 *  - stdout/stderr 파이프 깨짐 (터미널 재사용) 후 console.log 가 예외
 *  - listen EADDRINUSE 에 error 핸들러가 없으면 즉시 크래시
 */
import { logger } from "./logger.js";

const IGNORABLE = new Set([
    "EPIPE",
    "ECONNRESET",
    "ECONNABORTED",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
]);

let installed = false;

function errText(err) {
    if (err == null) return "unknown";
    if (err instanceof Error) return err.stack || err.message;
    return String(err);
}

function safeLog(level, message) {
    try {
        logger[level](message);
    } catch {
        try {
            const fn = level === "error" ? console.error : console.warn;
            fn(message);
        } catch {
            /* stdio 도 깨진 경우 */
        }
    }
}

export function isIgnorableNetError(err) {
    return IGNORABLE.has(err?.code) || IGNORABLE.has(err?.errno);
}

/** 프로세스 전역 가드. serve/agent/solo 에서 한 번만 설치. */
export function installProcessGuard() {
    if (installed) return;
    installed = true;

    const onStdioError = (err) => {
        if (isIgnorableNetError(err)) return;
        safeLog("warn", `stdio 오류: ${err?.message || err}`);
    };
    process.stdout?.on?.("error", onStdioError);
    process.stderr?.on?.("error", onStdioError);

    process.on("uncaughtException", (err) => {
        safeLog("error", `uncaughtException: ${errText(err)}`);
        // EPIPE 류는 연결이 끊긴 것뿐이라 프로세스를 유지한다.
        // 그 외도 로컬 관리서버는 이유 없이 꺼지지 않는 쪽이 낫다.
        if (!isIgnorableNetError(err)) {
            safeLog(
                "error",
                "uncaughtException 이후에도 관리서버는 계속 실행합니다. 위 스택을 확인하세요.",
            );
        }
    });

    process.on("unhandledRejection", (reason) => {
        const err = reason instanceof Error ? reason : new Error(String(reason));
        safeLog("error", `unhandledRejection: ${errText(err)}`);
    });
}

/**
 * HTTP 서버 수명 관련 기본값을 관리서버에 맞게 조정.
 * @param {import("node:http").Server} server
 * @param {{ port?: number, fatalListen?: boolean }} [opts]
 */
export function hardenHttpServer(server, { port, fatalListen = true } = {}) {
    if (fatalListen) {
        server.on("error", (e) => {
            if (e.code === "EADDRINUSE") {
                safeLog(
                    "error",
                    `포트 ${port ?? "?"} 이미 사용 중 (EADDRINUSE). 기존 프로세스를 종료하거나 PORT 를 바꾸세요.`,
                );
            } else {
                safeLog("error", `HTTP listen 실패: ${e.message}`);
            }
            process.exit(1);
        });
    }
    server.on("clientError", (err, socket) => {
        if (isIgnorableNetError(err)) {
            try {
                socket.destroy();
            } catch {
                /* ignore */
            }
            return;
        }
        safeLog("warn", `HTTP clientError: ${err.message}`);
        try {
            socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        } catch {
            /* ignore */
        }
    });
    // Node 18+ 기본값 300000ms. SSE/긴 채팅이 5분에 강제 종료되면
    // 이후 res.write 가 EPIPE 로 프로세스를 죽일 수 있다.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.timeout = 0;
    return server;
}
