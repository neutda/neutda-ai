// 모든 페이지에 공통 좌측 LNB를 주입한다. (스타일은 /nav.css)
// 접기(collapse) 지원: 접으면 아이콘만 표시. 상태는 localStorage 에 저장.
(function () {
    const groups = [
        {
            title: "운영",
            links: [
                {
                    href: "/monitor.html",
                    label: "서버 모니터링",
                    icon: "📊",
                    match: (p) => p.includes("monitor"),
                },
                {
                    href: "/stats.html",
                    label: "사용통계",
                    icon: "📈",
                    match: (p) => p.includes("stats"),
                },
                {
                    href: "/logs.html",
                    label: "로그",
                    icon: "📜",
                    match: (p) => p.includes("logs"),
                },
            ],
        },
        {
            title: "관리",
            links: [
                {
                    href: "/server-admin.html",
                    label: "서버/모델관리",
                    icon: "🖥️",
                    match: (p) =>
                        p.includes("server-admin") || p.includes("models"),
                },
                {
                    href: "/roles.html",
                    label: "모델 역할 관리",
                    icon: "🎭",
                    match: (p) => p.includes("roles"),
                },
                {
                    href: "/security.html",
                    label: "모델 보안 관리",
                    icon: "🛡️",
                    match: (p) => p.includes("security"),
                },
                {
                    href: "/knowledge.html",
                    label: "기초 지식 관리",
                    icon: "📚",
                    match: (p) => p.endsWith("/knowledge.html"),
                },
                {
                    href: "/rules.html",
                    label: "JSON 결과 관리",
                    icon: "⚖️",
                    match: (p) => p.endsWith("/rules.html"),
                },
                {
                    href: "/api-manage.html",
                    label: "외부 접근 관리",
                    icon: "🔌",
                    match: (p) =>
                        p.includes("api-manage") ||
                        p.includes("api-knowledge") ||
                        p.includes("api-rules") ||
                        p.includes("api.html"),
                },
            ],
        },
        {
            title: "테스트",
            links: [
                {
                    href: "/index.html",
                    label: "테스트 콘솔",
                    icon: "💬",
                    match: (p) => p === "/" || p.endsWith("/index.html"),
                },
                {
                    href: "/pipeline.html",
                    label: "파이프라인 테스트",
                    icon: "🔀",
                    match: (p) => p.includes("pipeline"),
                },
            ],
        },
    ];
    const path = location.pathname;
    const KEY = "lnbCollapsed";

    const FKEY = "lnbForceOpen";

    document.body.classList.add("app-with-lnb");
    // 접힘 상태를 렌더 전에 적용해 레이아웃 점프 최소화
    let collapsed = localStorage.getItem(KEY) === "1";
    document.body.classList.toggle("app-lnb-collapsed", collapsed);

    // 접힌 상태에서 메뉴를 눌러 이동한 경우: 브라우저는 로드 직후 마우스가
    // 위에 있어도 :hover 를 바로 적용하지 않는다. 강제로 펼친 채 시작하고,
    // 첫 마우스 이동 때 해제해 네이티브 :hover 로 넘긴다(그때 커서가 위면 유지,
    // 벗어났으면 접힘).
    if (collapsed && sessionStorage.getItem(FKEY) === "1") {
        sessionStorage.removeItem(FKEY);
        document.body.classList.add("lnb-force-open");
        document.addEventListener(
            "mousemove",
            () => document.body.classList.remove("lnb-force-open"),
            { once: true },
        );
    }

    if (document.querySelector("nav.app-lnb")) return;

    const esc = (s) =>
        String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");

    const nav = document.createElement("nav");
    nav.className = "app-lnb";
    nav.setAttribute("aria-label", "주 메뉴");
    nav.innerHTML =
        `<div class="brand-row">
            <div class="brand">neutda-ai</div>
            <button type="button" class="lnb-toggle" aria-label="메뉴 접기" title="메뉴 접기">
                <span class="chev">‹</span>
            </button>
        </div>` +
        groups
            .map((g) => {
                const items = g.links
                    .map(
                        (l) =>
                            `<a href="${l.href}" class="${l.match(path) ? "active" : ""}" title="${esc(l.label)}"><span class="ico">${l.icon}</span><span class="lab">${esc(l.label)}</span></a>`,
                    )
                    .join("");
                return `<div class="sec">${g.title}</div>${items}`;
            })
            .join("");

    document.body.insertBefore(nav, document.body.firstChild);

    // 접힌 상태에서 메뉴(링크) 클릭 시, 다음 페이지는 펼친 채로 시작하도록 표시
    nav.addEventListener("click", (e) => {
        if (
            e.target.closest("a") &&
            document.body.classList.contains("app-lnb-collapsed")
        ) {
            sessionStorage.setItem(FKEY, "1");
        }
    });

    const toggle = nav.querySelector(".lnb-toggle");
    toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        localStorage.setItem(KEY, collapsed ? "1" : "0");
        document.body.classList.toggle("app-lnb-collapsed", collapsed);
        const label = collapsed ? "메뉴 펼치기" : "메뉴 접기";
        toggle.setAttribute("aria-label", label);
        toggle.setAttribute("title", label);
    });
    if (collapsed) {
        toggle.setAttribute("aria-label", "메뉴 펼치기");
        toggle.setAttribute("title", "메뉴 펼치기");
    }

    // ===== 우측 레일: 노드별 실시간 차트 =====
    if (!document.querySelector("aside.app-rail")) {
        const RAIL_SERIES = [
            { key: "cpu", label: "CPU", color: "#d29922", get: (m) => m?.cpu?.usagePct },
            { key: "ram", label: "RAM", color: "#f85149", get: (m) => m?.mem?.usagePct },
            {
                key: "util",
                label: "GPU",
                color: "#3fb950",
                get: (m) => m?.gpus?.[0]?.utilPct,
            },
        ];
        const RAIL_MAXP = 40;
        const RAIL_HKEY = "railHist";
        const RAIL_TTL_MS = 10 * 60 * 1000; // 탭 세션 내 메뉴 이동 시 유지
        // 페이지 이동(전체 새로고침) 후에도 차트가 이어지도록 히스토리를
        // sessionStorage 에 저장/복원.
        let railHist = {}; // id -> {cpu:[],ram:[],util:[]}
        try {
            const saved = JSON.parse(sessionStorage.getItem(RAIL_HKEY) || "null");
            if (
                saved &&
                saved.t &&
                Date.now() - saved.t < RAIL_TTL_MS &&
                saved.hist &&
                typeof saved.hist === "object"
            ) {
                railHist = saved.hist;
                // 구버전 gpu/vram(점유) 키 정리 — 사용률(util)만 유지
                for (const h of Object.values(railHist)) {
                    if (!h || typeof h !== "object") continue;
                    delete h.gpu;
                    delete h.vram;
                }
            }
        } catch {}

        function persistRailHist() {
            try {
                sessionStorage.setItem(
                    RAIL_HKEY,
                    JSON.stringify({ t: Date.now(), hist: railHist }),
                );
            } catch {
                // quota / private mode
            }
        }

        const rail = document.createElement("aside");
        rail.className = "app-rail";
        rail.setAttribute("aria-label", "노드 실시간 차트");
        rail.innerHTML =
            `<div class="rail-title">실시간 · 노드</div>` +
            `<div class="rail-body"><div class="rail-empty">불러오는 중…</div></div>`;
        document.body.appendChild(rail);
        const railBody = rail.querySelector(".rail-body");

        function drawSpark(cv, h) {
            if (!cv || !h) return;
            const dpr = window.devicePixelRatio || 1;
            const w = cv.clientWidth || 176;
            const ht = cv.clientHeight || 54;
            cv.width = Math.round(w * dpr);
            cv.height = Math.round(ht * dpr);
            const ctx = cv.getContext("2d");
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, ht);
            const padT = 4;
            const padB = 4;
            const plotH = ht - padT - padB;
            const yOf = (v) => padT + (1 - v / 100) * plotH;
            const xOf = (i) => (RAIL_MAXP <= 1 ? 0 : (i / (RAIL_MAXP - 1)) * w);
            ctx.strokeStyle = "#1b2030";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, yOf(50));
            ctx.lineTo(w, yOf(50));
            ctx.stroke();
            for (const s of RAIL_SERIES) {
                const arr = h[s.key] || [];
                const off = RAIL_MAXP - arr.length;
                ctx.strokeStyle = s.color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                let started = false;
                for (let i = 0; i < arr.length; i++) {
                    const v = arr[i];
                    if (v == null) {
                        started = false;
                        continue;
                    }
                    const x = xOf(off + i);
                    const y = yOf(v);
                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else ctx.lineTo(x, y);
                }
                ctx.stroke();
            }
        }

        let railIds = "";
        async function railTick() {
            let agents = [];
            try {
                agents = (await (await fetch("/api/agents")).json()).agents || [];
            } catch {
                return;
            }
            const ids = agents.map((a) => a.id).join("|");
            if (ids !== railIds) {
                railIds = ids;
                railBody.innerHTML = agents.length
                    ? agents
                          .map(
                              (a) =>
                                  `<div class="rail-node" data-id="${esc(a.id)}">
                    <div class="rail-node-head"><span class="rdot ${a.status === "up" ? "up" : ""}"></span><b title="${esc(a.id)} · ${esc(a.host || "")}">${esc(a.id)}</b></div>
                    <canvas class="spark"></canvas>
                    <div class="rail-legend"></div>
                  </div>`,
                          )
                          .join("")
                    : `<div class="rail-empty">등록된 노드가 없습니다.<br />solo 또는 agent 로 등록하세요.</div>`;
            }
            for (const a of agents) {
                const h =
                    railHist[a.id] ||
                    (railHist[a.id] = {
                        cpu: [],
                        ram: [],
                        util: [],
                    });
                for (const s of RAIL_SERIES) {
                    if (!Array.isArray(h[s.key])) h[s.key] = [];
                    const v = s.get(a.metrics);
                    const arr = h[s.key];
                    arr.push(typeof v === "number" && isFinite(v) ? v : null);
                    if (arr.length > RAIL_MAXP) arr.shift();
                }
                const card = railBody.querySelector(
                    `.rail-node[data-id="${CSS.escape(a.id)}"]`,
                );
                if (!card) continue;
                drawSpark(card.querySelector("canvas"), h);
                card.querySelector(".rail-legend").innerHTML = RAIL_SERIES.map(
                    (s) => {
                        const arr = h[s.key] || [];
                        const last = arr.length ? arr[arr.length - 1] : null;
                        return `<span class="lg"><span class="sw" style="background:${s.color}"></span>${s.label} <b>${last == null ? "–" : last + "%"}</b></span>`;
                    },
                ).join("");
                const dot = card.querySelector(".rdot");
                if (dot) dot.classList.toggle("up", a.status === "up");
            }
            for (const id of Object.keys(railHist)) {
                if (!agents.some((a) => a.id === id)) delete railHist[id];
            }
            persistRailHist();
        }
        railTick();
        setInterval(railTick, 1500);
        // 메뉴 이동 직전에도 한 번 더 저장
        window.addEventListener("pagehide", persistRailHist);
        window.addEventListener("beforeunload", persistRailHist);
    }
})();
