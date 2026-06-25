// 모든 페이지 상단에 공통 네비게이션 바를 주입한다.
(function () {
    const links = [
        {
            href: "/",
            label: "테스트 콘솔",
            match: (p) => p === "/" || p.endsWith("/index.html"),
        },
        {
            href: "/monitor.html",
            label: "모니터링",
            match: (p) => p.includes("monitor"),
        },
        { href: "/logs.html", label: "로그", match: (p) => p.includes("logs") },
        {
            href: "/api.html",
            label: "외부 API",
            match: (p) => p.includes("api.html"),
        },
    ];
    const path = location.pathname;

    const style = document.createElement("style");
    style.textContent = `
    .app-nav{display:flex;gap:4px;align-items:center;background:#0c0e14;border-bottom:1px solid #272b38;padding:8px 16px;position:sticky;top:0;z-index:100;}
    .app-nav .brand{font-size:13px;font-weight:700;color:#e7e9ee;margin-right:10px;}
    .app-nav a{font-size:13px;color:#9aa3b2;text-decoration:none;padding:6px 12px;border-radius:7px;font-weight:600;}
    .app-nav a:hover{background:#171a23;color:#e7e9ee;}
    .app-nav a.active{background:rgba(108,140,255,.16);color:#6c8cff;}
  `;
    document.head.appendChild(style);

    const nav = document.createElement("nav");
    nav.className = "app-nav";
    nav.innerHTML =
        `<span class="brand">neutda-ai</span>` +
        links
            .map(
                (l) =>
                    `<a href="${l.href}" class="${l.match(path) ? "active" : ""}">${l.label}</a>`,
            )
            .join("");

    document.body.insertBefore(nav, document.body.firstChild);
})();
