// 페이지 안쪽(.app-main)에 2차 LNB(서브 내비)를 주입한다.
// "외부 접근 관리" 섹션의 하위 페이지들에서 공통으로 사용한다.
// (server-admin 의 페이지 내 aside.lnb 패턴과 동일한 구조)
(function () {
    const SECTION = {
        title: "외부 접근 관리",
        groups: [
            {
                title: "관리",
                items: [
                    {
                        href: "/api-manage.html",
                        label: "외부 API 관리",
                        icon: "🔑",
                        match: (p) => p.includes("api-manage"),
                    },
                    {
                        href: "/api-knowledge.html",
                        label: "API별 기초지식 설정",
                        icon: "🗂️",
                        match: (p) => p.includes("api-knowledge"),
                    },
                    {
                        href: "/api-rules.html",
                        label: "API별 JSON 결과 설정",
                        icon: "⚖️",
                        match: (p) => p.includes("api-rules"),
                    },
                ],
            },
            {
                // 맨 아래: 기존 테스트 콘솔을 별도 항목으로
                title: "테스트",
                items: [
                    {
                        href: "/api.html",
                        label: "외부 API 테스트",
                        icon: "🧪",
                        match: (p) => p.includes("api.html"),
                    },
                ],
            },
        ],
    };

    const path = location.pathname;
    const esc = (s) =>
        String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");

    // 스타일 1회 주입
    if (!document.getElementById("subnav-style")) {
        const st = document.createElement("style");
        st.id = "subnav-style";
        st.textContent = `
.app-main.has-subnav {
    display: flex;
    gap: 16px;
    align-items: flex-start;
}
.app-main.has-subnav > .subnav-main {
    flex: 1 1 auto;
    min-width: 0;
}
.subnav {
    flex: 0 0 216px;
    box-sizing: border-box;
    position: sticky;
    top: 0;
    align-self: flex-start;
    background: #12151d;
    border: 1px solid #232838;
    border-radius: 10px;
    padding: 8px;
    font-family: ui-sans-serif, system-ui, "Segoe UI", "Malgun Gothic", sans-serif;
}
.subnav .subnav-title {
    font-size: 12px;
    font-weight: 700;
    color: #e7e9ee;
    padding: 6px 10px 8px;
}
.subnav .subnav-sec {
    font-size: 10px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 12px 10px 4px;
}
.subnav .subnav-sec + .subnav-item {
    margin-top: 0;
}
.subnav a.subnav-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 10px;
    border-radius: 8px;
    color: #c9d1d9;
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    border: 1px solid transparent;
}
.subnav a.subnav-item:hover {
    background: #1c2129;
    color: #e7e9ee;
}
.subnav a.subnav-item.active {
    background: rgba(108, 140, 255, 0.16);
    border-color: rgba(108, 140, 255, 0.4);
    color: #a9c0ff;
}
.subnav .subnav-item .ico {
    flex: 0 0 18px;
    width: 18px;
    text-align: center;
}
@media (max-width: 720px) {
    .app-main.has-subnav {
        flex-direction: column;
    }
    .subnav {
        position: static;
        width: 100%;
        flex: 0 0 auto;
    }
}`;
        document.head.appendChild(st);
    }

    const main = document.querySelector(".app-main");
    if (!main || main.classList.contains("has-subnav")) return;

    // 기존 본문을 래핑
    const content = document.createElement("div");
    content.className = "subnav-main";
    while (main.firstChild) content.appendChild(main.firstChild);

    const aside = document.createElement("aside");
    aside.className = "subnav";
    aside.setAttribute("aria-label", SECTION.title + " 하위 메뉴");
    aside.innerHTML =
        `<div class="subnav-title">${esc(SECTION.title)}</div>` +
        SECTION.groups
            .map(
                (g) =>
                    `<div class="subnav-sec">${esc(g.title)}</div>` +
                    g.items
                        .map(
                            (it) =>
                                `<a href="${it.href}" class="subnav-item ${it.match(path) ? "active" : ""}" title="${esc(it.label)}"><span class="ico">${it.icon}</span><span class="lab">${esc(it.label)}</span></a>`,
                        )
                        .join(""),
            )
            .join("");

    main.classList.add("has-subnav");
    main.appendChild(aside);
    main.appendChild(content);
})();
