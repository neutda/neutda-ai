// 단일 서버 모드 진입점.  `npm run solo`
//
// 하위 노드를 따로 띄우지 않고 한 프로세스에서 부모(관리서버)와
// 에이전트를 함께 실행한다. 에이전트는 자기 servers.json 을 로컬(127.0.0.1)
// 로 부모에 등록하므로, 서버/모델관리·모니터링 화면이 그대로 정상 동작한다.
//
// 분산 배포가 필요하면 대신  `npm run serve`(부모) 와  각 머신의
// `npm run agent` 를 쓴다.
import "dotenv/config";

// 부모/에이전트가 config 를 읽기 전에 단일 서버용 기본값을 심는다.
// (이미 .env/환경변수로 지정돼 있으면 그대로 존중)
const PORT = process.env.PORT || "3000";
process.env.SOLO ||= "1";
process.env.AGENT_ID ||= "local";
process.env.AGENT_HOST ||= "127.0.0.1"; // 부모 → llama 를 로컬로 접속
process.env.PARENT_URL ||= `http://127.0.0.1:${PORT}`;

// 부모 먼저(포트 리슨) → 에이전트(등록/하트비트).
// 부모가 아직 안 떠 있어도 에이전트 하트비트가 재시도하므로 순서 의존은 없다.
await import("./server.js");
await import("./agent.js");
