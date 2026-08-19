// 서버 정의(def) → 부모 풀(backend) 반영의 공용 헬퍼.
//
// 로컬 서버(servers.json)든 하위 관리서버(agent)가 보고한 원격 서버든,
// 풀에 백엔드로 얹는 방식은 같다. 역할·보안 정책은 부모(컨트롤 플레인)의
// roles.json / security.json 카탈로그로 해석한다.
import { pool } from "./pool.js";
import { serverUrl } from "./serverUrl.js";
import { rolesById, loadRolesSync, resolveServerRoles } from "./roles.js";
import { resolveServerSecurity } from "./securityPolicies.js";
import { config } from "./config.js";

/** def → 풀 등록에 쓰는 해석 결과 (역할/보안/티어/장치/별칭/고정플래그) */
function resolveForPool(def) {
    const resolved = resolveServerRoles(def, rolesById(loadRolesSync()));
    const sec = resolveServerSecurity(def);
    const tier = String(def.tier || "large").toLowerCase();
    return {
        url: serverUrl(def),
        tier: tier === "router" ? "small" : tier,
        device: Number(def.ngl) > 0 ? "gpu" : "cpu",
        alias: (def.alias && String(def.alias).trim()) || def.name || null,
        resolved,
        fixed: {
            solve: def.solve !== false && def.chat !== false,
            router: def.router === true,
            planner: def.planner === true,
            embedding: def.embedding === true,
            security: def.security === true,
            quality: def.quality === true,
            securityIds: sec.securityIds,
            securityPolicy: sec.securityPolicyText,
            ctx: Number(def.ctx) > 0 ? Number(def.ctx) : config.llamaDefaultCtx,
            parallel:
                Number(def.parallel) > 0
                    ? Math.min(config.llamaParallelCap, Math.floor(Number(def.parallel)))
                    : undefined,
            vision: Boolean(def.mmproj && String(def.mmproj).trim()),
        },
    };
}

/**
 * def 를 풀에 등록(없으면 추가, 있으면 역할·보안·별칭만 갱신).
 * 이미 있는 백엔드는 재추가하지 않아 health/통계가 리셋되지 않는다.
 * @returns {{ url: string, added: boolean }}
 */
export function upsertBackendFromDef(def) {
    const r = resolveForPool(def);
    const existing = pool.backends.find((b) => b.url === r.url);
    if (existing) {
        pool.setAlias(r.url, r.alias);
        existing.ctx = r.fixed.ctx;
        if (r.fixed.parallel != null) existing.parallel = r.fixed.parallel;
        existing.vision = r.fixed.vision;
        pool.setRoleAssignment(r.url, {
            roleIds: r.resolved.roleIds,
            customSkills: r.resolved.customSkills,
            commonSkills: r.resolved.commonSkills,
            skills: r.resolved.skills,
        });
        for (const role of ["solve", "router", "planner", "embedding", "security", "quality"]) {
            pool.setRoleEnabled(r.url, role, r.fixed[role]);
        }
        if (r.fixed.security) {
            pool.setSecurityAssignment(r.url, {
                securityIds: r.fixed.securityIds,
                securityPolicy: r.fixed.securityPolicy,
            });
        }
        return { url: r.url, added: false };
    }
    pool.addBackend(
        r.url,
        r.tier,
        r.device,
        r.alias,
        r.fixed.router,
        r.resolved.skills,
        r.resolved.roleIds,
        r.resolved.customSkills,
        r.fixed,
    );
    return { url: r.url, added: true };
}

/** def 를 풀에서 제거 */
export function removeBackendFromDef(def) {
    return pool.removeBackend(serverUrl(def));
}
