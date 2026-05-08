// ================================================================
// RankPilot Mobile v2.0 — Full Rebuild
// 토스 디자인 시스템 + Web Share API + 카톡 공유 + 카드 패턴
// ================================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ================================================================
// 전역 상태
// ================================================================
const State = {
    profile: null,           // 사용자 프로필 (admin 여부 등)
    isAdmin: false,
    
    groups: [],              // 본인 그룹
    advertiserGroups: [],    // 광고주 그룹 (admin 전용) - { user_id, email, groups: [...] }
    
    keywords: [],            // 모든 키워드 (latest result + oneshot 머지)
    
    currentTab: "home",
    currentGroupId: null,    // 그룹 상세 보고 있는 그룹 ID
    currentGroupContext: null, // { group, keywords, owner_user_id (광고주 그룹일 때) }
    
    matrixGroupId: null,     // 매트릭스 화면에서 보고 있는 그룹
    
    captureUrlCache: new Map(), // filename -> blob url (캐시)
};

// ================================================================
// Utils
// ================================================================

function showToast(message, type = "info", duration = 2500) {
    const container = $("#toast-container");
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = "toastIn 0.2s reverse";
        setTimeout(() => toast.remove(), 200);
    }, duration);
}

function fmtTime(iso) {
    if (!iso) return "-";
    try {
        const d = new Date(iso);
        const now = new Date();
        const diffMs = now - d;
        const diffMin = Math.floor(diffMs / 60000);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);
        if (diffMin < 1) return "방금";
        if (diffMin < 60) return `${diffMin}분 전`;
        if (diffHour < 24) return `${diffHour}시간 전`;
        if (diffDay < 7) return `${diffDay}일 전`;
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${m}/${day}`;
    } catch { return "-"; }
}

function fmtDateTime(iso) {
    if (!iso) return "-";
    try {
        const d = new Date(iso);
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${m}/${day} ${hh}:${mm}`;
    } catch { return "-"; }
}

function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function shortUrl(url, max = 36) {
    if (!url) return "";
    let s = String(url).replace(/^https?:\/\//, "");
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
}

function ensureUrl(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return "https://" + url;
}

// 영역 추론 (PC앱과 같은 로직)
function inferArea(targetUrl) {
    if (!targetUrl) return "site";
    const u = String(targetUrl).toLowerCase();
    if (u.includes("blog.naver.com") || u.includes("m.blog.naver")) return "blog";
    if (u.includes("cafe.naver.com") || u.includes("m.cafe.naver")) return "cafe";
    if (u.includes("place.naver.com") || u.includes("m.place.naver") || u.includes("map.naver")) return "place";
    return "site";
}

const AREA_LABEL = { blog: "블로그", cafe: "카페", place: "플레이스", site: "사이트" };

// 키워드 상태 분류 (PC앱 v1.1.7과 동일 — 건바이용)
function classifyKeyword(kw) {
    // 빠른 노출 완료 (수동 체크 — first_exposed_at 있고 manual)
    if (kw.oneshot_state === "verified" || kw.oneshot_first_exposed_at) {
        // 24h 이내인지 검증 중인지 확인
        if (kw.oneshot_first_exposed_at) {
            const exposedAt = new Date(kw.oneshot_first_exposed_at);
            const now = new Date();
            const diffHr = (now - exposedAt) / 3600000;
            if (diffHr < 24 && kw.oneshot_state !== "verified") {
                return "awaiting"; // 24h 검증 중
            }
            return "stable"; // 노출 안정
        }
        return "stable";
    }
    
    // 마지막 검사 결과 기반
    if (kw.last_rank == null) {
        // 아직 검사 안 됨
        return "pending";
    }
    if (kw.last_rank > 0) {
        // 노출됨 (자동 검사 결과 — 광고주에게 보고 가능)
        return "stable";
    }
    // last_rank === 0 → 미노출 → 조치 필요
    return "action";
}

// ================================================================
// 라우팅
// ================================================================

function navigate(tab, params = {}) {
    State.currentTab = tab;
    
    // 모든 화면 숨김
    $$(".screen").forEach(s => s.classList.remove("active"));
    
    // 헤더 백 버튼
    const backBtn = $("#header-back-btn");
    
    if (tab === "group-detail") {
        $("#screen-group-detail").classList.add("active");
        backBtn.classList.remove("hidden");
        $("#header-title").textContent = "그룹 상세";
        State.currentGroupId = params.groupId;
        State.currentGroupContext = params.context || null;
        renderGroupDetail();
    } else {
        // 메인 5탭
        const screenId = `screen-${tab}`;
        const screen = $(`#${screenId}`);
        if (screen) screen.classList.add("active");
        backBtn.classList.add("hidden");
        
        // 탭 active
        $$(".bottom-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
        
        // 헤더 타이틀
        const titles = {
            home: "RankPilot",
            groups: "그룹",
            matrix: "월보장",
            settings: "내정보",
        };
        $("#header-title").textContent = titles[tab] || "RankPilot";
        
        // 화면별 렌더
        if (tab === "home") renderHome();
        else if (tab === "groups") renderGroups();
        else if (tab === "matrix") renderMatrix();
        else if (tab === "settings") renderSettings();
    }
    
    // 스크롤 맨 위로
    window.scrollTo(0, 0);
}

function goBack() {
    if (State.currentTab === "group-detail") {
        navigate("groups");
    } else {
        navigate("home");
    }
}

// ================================================================
// 인증
// ================================================================

async function init() {
    // 세션 복원 시도
    const session = Session.load();
    if (session && session.user) {
        try {
            // 토큰 유효성 검증 + 자동 갱신
            const valid = await Auth.ensureValidToken();
            if (valid) {
                await afterLogin();
                return;
            }
            // 갱신 실패 — 로그인 화면
            Session.clear();
        } catch (e) {
            console.warn("세션 복원 실패:", e);
            Session.clear();
        }
    }
    $("#loading-screen").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
}

async function handleLogin(e) {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    const btn = $("#login-btn");
    const errorEl = $("#login-error");
    
    errorEl.classList.add("hidden");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> 로그인 중...';
    
    try {
        const r = await Auth.login(email, password);
        if (!r || !r.ok) {
            throw new Error(r?.error || "이메일 또는 비밀번호를 확인해주세요");
        }
        await afterLogin();
    } catch (err) {
        errorEl.textContent = err.message || "로그인 실패";
        errorEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "로그인";
    }
}

async function afterLogin() {
    $("#loading-screen").classList.remove("hidden");
    $("#login-screen").classList.add("hidden");
    
    try {
        // 프로필 + 데이터 로드
        await loadAllData();
        
        $("#loading-screen").classList.add("hidden");
        $("#main-app").classList.remove("hidden");
        navigate("home");
    } catch (err) {
        console.error(err);
        showToast("데이터 로드 실패: " + err.message, "error");
        $("#loading-screen").classList.add("hidden");
        $("#main-app").classList.remove("hidden");
        navigate("home");
    }
}

async function handleLogout() {
    await Auth.logout();
    location.reload();
}

// ================================================================
// 데이터 로드
// ================================================================

async function loadAllData() {
    const profile = await API.getUserProfile();
    State.profile = profile;
    State.isAdmin = !!profile.is_admin;
    
    // 본인 그룹 + 키워드
    const [groups, keywords] = await Promise.all([
        API.listGroups(),
        API.listKeywordsWithLatestResult(),
    ]);
    State.groups = groups;
    State.keywords = keywords;
    
    // admin이면 광고주 그룹도 로드
    if (State.isAdmin) {
        await loadAdvertiserData();
    }
}

async function loadAdvertiserData() {
    // 모든 사용자 프로필 + 그룹 + 키워드 (admin RLS 통과)
    try {
        const [profilesRes, groupsRes, keywordsRes, oneshotRes] = await Promise.all([
            DB.select("user_profiles", { limit: 1000 }),
            DB.select("groups", { limit: 1000 }),
            DB.select("keywords", { limit: 5000 }),
            DB.select("oneshot_jobs", { limit: 5000 }),
        ]);
        
        if (!profilesRes.ok) throw new Error("프로필 로드 실패");
        if (!groupsRes.ok) throw new Error("그룹 로드 실패");
        
        const profiles = profilesRes.data || [];
        const allGroups = groupsRes.data || [];
        const allKws = keywordsRes.ok ? (keywordsRes.data || []) : [];
        const allOneshot = oneshotRes.ok ? (oneshotRes.data || []) : [];
        
        const myUserId = Session.user()?.id;
        
        // 결과도 머지
        const kwIds = allKws.map(k => k.id);
        let allResults = [];
        if (kwIds.length > 0) {
            // 너무 많을 수 있어 batch로 처리
            const batchSize = 100;
            for (let i = 0; i < kwIds.length; i += batchSize) {
                const batch = kwIds.slice(i, i + batchSize);
                const r = await DB.select("results", {
                    filters: { keyword_id: `in.(${batch.join(",")})` },
                    order: "id.desc",
                    limit: 5000,
                });
                if (r.ok) allResults = allResults.concat(r.data);
            }
        }
        
        // keyword_id → latest result 매핑
        const latestMap = new Map();
        for (const r of allResults) {
            if (!latestMap.has(r.keyword_id)) latestMap.set(r.keyword_id, r);
        }
        
        // keyword_id → oneshot_job 매핑
        const oneshotMap = new Map();
        for (const o of allOneshot) oneshotMap.set(o.keyword_id, o);
        
        // 광고주별 그룹화 (본인 제외)
        const advertiserMap = new Map(); // user_id -> { profile, groups: [] }
        for (const p of profiles) {
            if (p.user_id === myUserId) continue;
            advertiserMap.set(p.user_id, { profile: p, groups: [] });
        }
        
        for (const g of allGroups) {
            if (g.user_id === myUserId) continue; // 본인 그룹 제외
            const adv = advertiserMap.get(g.user_id);
            if (adv) {
                // 그룹의 키워드 + 결과 머지
                const groupKws = allKws
                    .filter(k => k.group_id === g.id)
                    .map(k => {
                        const last = latestMap.get(k.id);
                        const oj = oneshotMap.get(k.id);
                        return {
                            ...k,
                            last_rank: last?.rank ?? null,
                            last_section: last?.section ?? null,
                            last_check_at: last?.timestamp ?? null,
                            oneshot_state: oj?.state ?? null,
                            oneshot_first_exposed_at: oj?.first_exposed_at ?? null,
                            oneshot_first_rank: oj?.first_rank ?? null,
                            oneshot_first_screenshot: oj?.first_screenshot ?? null,
                        };
                    });
                adv.groups.push({ ...g, keywords: groupKws });
            }
        }
        
        State.advertiserGroups = Array.from(advertiserMap.values())
            .filter(a => a.groups.length > 0)
            .sort((a, b) => (a.profile.email || "").localeCompare(b.profile.email || ""));
    } catch (e) {
        console.error("광고주 데이터 로드 실패:", e);
        State.advertiserGroups = [];
    }
}

// 새로고침
async function handleRefresh() {
    const btn = $("#refresh-btn");
    btn.disabled = true;
    btn.style.opacity = "0.4";
    try {
        await loadAllData();
        navigate(State.currentTab, {
            groupId: State.currentGroupId,
            context: State.currentGroupContext,
        });
        showToast("새로고침 완료", "success", 1500);
    } catch (err) {
        showToast("새로고침 실패", "error");
    } finally {
        btn.disabled = false;
        btn.style.opacity = "1";
    }
}

// ================================================================
// 화면: 홈
// ================================================================

function renderHome() {
    const profile = State.profile;
    const email = Session.user()?.email || "사용자";
    $("#home-subtitle").textContent = email;
    
    // 통계
    const total = State.keywords.length;
    const exposed = State.keywords.filter(k => (k.last_rank ?? 0) > 0 || k.oneshot_first_exposed_at).length;
    const action = State.keywords.filter(k => classifyKeyword(k) === "action").length;
    
    $("#stat-total").textContent = total;
    $("#stat-exposed").textContent = exposed;
    $("#stat-action").textContent = action;
    
    // 조치 필요 키워드
    const actionList = $("#home-action-list");
    const actionKws = State.keywords
        .filter(k => classifyKeyword(k) === "action")
        .slice(0, 5);
    
    if (actionKws.length === 0) {
        actionList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">✨</div>
                <div class="empty-state-title">모두 양호해요</div>
                <div>조치가 필요한 키워드가 없어요</div>
            </div>
        `;
    } else {
        actionList.innerHTML = actionKws.map(k => renderKeywordCard(k, { mini: true })).join("");
        bindKeywordCardEvents(actionList);
    }
    
    // 본인 그룹 (간략)
    const groupsList = $("#home-groups-list");
    const myGroups = State.groups.slice(0, 3);
    if (myGroups.length === 0) {
        groupsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📁</div>
                <div class="empty-state-title">아직 그룹이 없어요</div>
                <div>그룹 탭에서 만들어보세요</div>
            </div>
        `;
    } else {
        groupsList.innerHTML = myGroups.map(g => renderGroupCard(g)).join("");
        bindGroupCardEvents(groupsList);
    }
}

// ================================================================
// 화면: 그룹 목록
// ================================================================

function renderGroups() {
    const total = State.groups.length;
    const advCount = State.advertiserGroups.reduce((sum, a) => sum + a.groups.length, 0);
    $("#groups-count").textContent = State.isAdmin
        ? `내 그룹 ${total}개 · 광고주 그룹 ${advCount}개`
        : `${total}개`;
    
    const list = $("#groups-list");
    let html = "";
    
    // 본인 그룹
    if (State.groups.length > 0) {
        if (State.isAdmin) {
            html += `<div class="section-divider">📁 내 그룹</div>`;
        }
        html += State.groups.map(g => renderGroupCard(g)).join("");
    }
    
    // 광고주 그룹 (admin만)
    if (State.isAdmin && State.advertiserGroups.length > 0) {
        html += `<div class="section-divider">👥 광고주 그룹</div>`;
        for (const adv of State.advertiserGroups) {
            const advEmail = escapeHtml(adv.profile.email || "(이메일 없음)");
            const groupCount = adv.groups.length;
            const totalKws = adv.groups.reduce((s, g) => s + (g.keywords?.length || 0), 0);
            html += `
                <div class="advertiser-folder" data-advertiser-id="${adv.profile.user_id}">
                    <div class="advertiser-folder-header">
                        <div class="advertiser-folder-arrow">›</div>
                        <div class="advertiser-folder-name">${advEmail}</div>
                        <div class="advertiser-folder-count">${groupCount}그룹 · ${totalKws}키워드</div>
                    </div>
                    <div class="advertiser-folder-body">
                        ${adv.groups.map(g => renderGroupCard(g, { ownerUserId: adv.profile.user_id, ownerEmail: adv.profile.email })).join("")}
                    </div>
                </div>
            `;
        }
    }
    
    if (html === "") {
        html = `
            <div class="empty-state">
                <div class="empty-state-icon">📁</div>
                <div class="empty-state-title">아직 그룹이 없어요</div>
                <div>+ 새 그룹 버튼을 눌러 시작해보세요</div>
            </div>
        `;
    }
    
    list.innerHTML = html;
    
    // 광고주 폴더 토글
    list.querySelectorAll(".advertiser-folder-header").forEach(h => {
        h.addEventListener("click", () => {
            h.parentElement.classList.toggle("open");
        });
    });
    
    bindGroupCardEvents(list);
}

function renderGroupCard(g, opts = {}) {
    const isMonthly = g.mode === "monthly";
    const icon = isMonthly ? "📅" : "⚡";
    const iconClass = isMonthly ? "icon-monthly" : "icon-oneshot";
    const badgeClass = isMonthly ? "badge-monthly" : "badge-oneshot";
    const badgeText = isMonthly ? "월보장" : "건바이";
    const kwCount = g.keywords?.length ?? "?";
    const ownerData = opts.ownerUserId ? `data-owner="${opts.ownerUserId}" data-owner-email="${escapeHtml(opts.ownerEmail || "")}"` : "";
    
    return `
        <div class="group-card" data-group-id="${g.id}" ${ownerData}>
            <div class="group-card-icon ${iconClass}">${icon}</div>
            <div class="group-card-info">
                <div class="group-card-name">
                    ${escapeHtml(g.name)}
                    <span class="group-card-badge ${badgeClass}">${badgeText}</span>
                </div>
                <div class="group-card-meta">
                    <span>키워드 ${kwCount}개</span>
                </div>
            </div>
            <div class="group-card-arrow">›</div>
        </div>
    `;
}

function bindGroupCardEvents(container) {
    container.querySelectorAll(".group-card").forEach(card => {
        card.addEventListener("click", () => {
            const groupId = parseInt(card.dataset.groupId, 10);
            const ownerId = card.dataset.owner || null;
            const ownerEmail = card.dataset.ownerEmail || null;
            const context = ownerId ? { ownerUserId: ownerId, ownerEmail } : null;
            navigate("group-detail", { groupId, context });
        });
    });
}

// ================================================================
// 화면: 그룹 상세
// ================================================================

function getGroupAndKeywords(groupId, ownerUserId = null) {
    let group, keywords;
    if (ownerUserId) {
        // 광고주 그룹
        const adv = State.advertiserGroups.find(a => a.profile.user_id === ownerUserId);
        if (!adv) return null;
        group = adv.groups.find(g => g.id === groupId);
        if (!group) return null;
        keywords = group.keywords || [];
    } else {
        group = State.groups.find(g => g.id === groupId);
        if (!group) return null;
        keywords = State.keywords.filter(k => k.group_id === groupId);
    }
    return { group, keywords };
}

function renderGroupDetail() {
    const ownerUserId = State.currentGroupContext?.ownerUserId || null;
    const data = getGroupAndKeywords(State.currentGroupId, ownerUserId);
    if (!data) {
        $("#group-detail-content").innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">😶</div>
                <div class="empty-state-title">그룹을 찾을 수 없어요</div>
            </div>
        `;
        return;
    }
    
    const { group, keywords } = data;
    const isMonthly = group.mode === "monthly";
    const ownerEmail = State.currentGroupContext?.ownerEmail;
    
    // 분류
    const counts = {
        all: keywords.length,
        action: keywords.filter(k => classifyKeyword(k) === "action").length,
        stable: keywords.filter(k => classifyKeyword(k) === "stable").length,
        awaiting: keywords.filter(k => classifyKeyword(k) === "awaiting").length,
        pending: keywords.filter(k => classifyKeyword(k) === "pending").length,
    };
    
    const filterKey = State._groupDetailFilter || "all";
    
    let html = `
        <div class="group-detail-header">
            <div class="group-detail-name">
                ${escapeHtml(group.name)}
                <span class="group-card-badge ${isMonthly ? 'badge-monthly' : 'badge-oneshot'}">${isMonthly ? '월보장' : '건바이'}</span>
            </div>
            <div class="group-detail-meta">
                ${ownerEmail ? `👤 ${escapeHtml(ownerEmail)} · ` : ''}
                키워드 ${keywords.length}개
            </div>
            <div class="group-detail-actions">
                ${!isMonthly ? `
                    <button class="group-action-btn is-primary" id="grp-detail-share-all">
                        📊 카톡 보고
                    </button>
                ` : `
                    <button class="group-action-btn" id="grp-detail-go-matrix">
                        📊 7일 매트릭스
                    </button>
                `}
                ${!ownerUserId ? `
                    <button class="group-action-btn" id="grp-detail-add-kw">
                        + 키워드
                    </button>
                ` : ''}
            </div>
        </div>
        
        <div class="filter-tabs">
            <button class="filter-tab ${filterKey === 'all' ? 'active' : ''}" data-filter="all">전체 <span class="filter-tab-count">${counts.all}</span></button>
            <button class="filter-tab ${filterKey === 'action' ? 'active' : ''}" data-filter="action">🚨 조치 <span class="filter-tab-count">${counts.action}</span></button>
            <button class="filter-tab ${filterKey === 'stable' ? 'active' : ''}" data-filter="stable">✅ 노출 <span class="filter-tab-count">${counts.stable}</span></button>
            <button class="filter-tab ${filterKey === 'awaiting' ? 'active' : ''}" data-filter="awaiting">⏳ 24h <span class="filter-tab-count">${counts.awaiting}</span></button>
            ${counts.pending > 0 ? `<button class="filter-tab ${filterKey === 'pending' ? 'active' : ''}" data-filter="pending">… 대기 <span class="filter-tab-count">${counts.pending}</span></button>` : ''}
        </div>
    `;
    
    // 필터 적용
    let filtered = keywords;
    if (filterKey !== "all") {
        filtered = keywords.filter(k => classifyKeyword(k) === filterKey);
    }
    
    if (filtered.length === 0) {
        html += `
            <div class="empty-state">
                <div class="empty-state-icon">${filterKey === 'action' ? '✨' : '🔍'}</div>
                <div class="empty-state-title">${filterKey === 'action' ? '모두 양호해요' : '키워드가 없어요'}</div>
            </div>
        `;
    } else {
        html += filtered.map(k => renderKeywordCard(k, { ownerUserId })).join("");
    }
    
    $("#group-detail-content").innerHTML = html;
    
    // 이벤트 바인딩
    $$(".filter-tab").forEach(t => {
        t.addEventListener("click", () => {
            State._groupDetailFilter = t.dataset.filter;
            renderGroupDetail();
        });
    });
    
    const shareAllBtn = $("#grp-detail-share-all");
    if (shareAllBtn) shareAllBtn.addEventListener("click", () => openGroupShareModal(group, keywords, ownerUserId));
    
    const matrixBtn = $("#grp-detail-go-matrix");
    if (matrixBtn) matrixBtn.addEventListener("click", () => {
        State.matrixGroupId = group.id;
        navigate("matrix");
    });
    
    const addKwBtn = $("#grp-detail-add-kw");
    if (addKwBtn) addKwBtn.addEventListener("click", () => openKeywordModal(group.id));
    
    bindKeywordCardEvents($("#group-detail-content"));
}

// ================================================================
// 키워드 카드 렌더링
// ================================================================

function renderKeywordCard(k, opts = {}) {
    const ownerUserId = opts.ownerUserId || null;
    const mini = opts.mini || false;
    
    const state = classifyKeyword(k);
    const stateClass = `state-${state === 'pending' ? 'awaiting' : state}`;
    
    // 영역
    const area = inferArea(k.target_url);
    const areaLabel = AREA_LABEL[area] || area;
    
    // 순위 뱃지
    let rankBadge = "";
    if (k.oneshot_first_exposed_at && k.oneshot_first_rank) {
        rankBadge = `<span class="rank-badge rank-${k.oneshot_first_rank === 1 ? '1' : k.oneshot_first_rank <= 3 ? 'mid' : 'low'}">${k.oneshot_first_rank}등</span>`;
    } else if (k.last_rank > 0) {
        const r = k.last_rank;
        const cls = r === 1 ? "rank-1" : r <= 3 ? "rank-mid" : "rank-low";
        rankBadge = `<span class="rank-badge ${cls}">${r}등</span>`;
    } else if (k.last_rank === 0) {
        rankBadge = `<span class="rank-badge rank-none">미노출</span>`;
    } else {
        rankBadge = `<span class="rank-badge rank-pending">대기</span>`;
    }
    
    // 메타 정보
    let metaHtml = "";
    if (k.oneshot_first_exposed_at) {
        const date = fmtDateTime(k.oneshot_first_exposed_at);
        const verifiedAt = new Date(k.oneshot_first_exposed_at);
        verifiedAt.setHours(verifiedAt.getHours() + 24);
        const verifiedStr = fmtDateTime(verifiedAt.toISOString());
        const isVerified = k.oneshot_state === "verified";
        metaHtml = `
            <div class="keyword-meta-row">
                ⏰ 최초 ${date}
            </div>
            <div class="keyword-meta-row ${isVerified ? '' : 'warn'}">
                ${isVerified ? '✅' : '⏳'} ${isVerified ? `검증 ${verifiedStr}` : `검증 ${verifiedStr} 예정`}
            </div>
        `;
    } else if (k.last_check_at) {
        metaHtml = `<div class="keyword-meta-row">최근 검사 ${fmtTime(k.last_check_at)}</div>`;
        if (state === "action") {
            metaHtml += `<div class="keyword-meta-row danger">🚨 노출 안 됨</div>`;
        }
    } else {
        metaHtml = `<div class="keyword-meta-row">아직 검사 전이에요</div>`;
    }
    
    // 액션 버튼 — 캡처 / 완료 / 공유
    const hasCapture = !!(k.oneshot_first_screenshot || (k.last_rank > 0));
    const isDone = !!(k.oneshot_first_exposed_at);
    
    let actionsHtml = "";
    if (!mini) {
        const ownerAttr = ownerUserId ? `data-owner="${ownerUserId}"` : "";
        actionsHtml = `
            <div class="keyword-actions">
                <button class="kw-action-btn" data-action="capture" data-kw-id="${k.id}" ${ownerAttr} ${!hasCapture ? 'disabled' : ''}>
                    <span class="kw-action-icon">📷</span> 캡처
                </button>
                <button class="kw-action-btn btn-success ${isDone ? 'is-checked' : ''}" data-action="check" data-kw-id="${k.id}" ${ownerAttr}>
                    <span class="kw-action-icon">${isDone ? '✓' : '☐'}</span> ${isDone ? '완료' : '체크'}
                </button>
                <button class="kw-action-btn btn-share" data-action="share" data-kw-id="${k.id}" ${ownerAttr}>
                    <span class="kw-action-icon">📤</span> 공유
                </button>
            </div>
        `;
    }
    
    return `
        <div class="keyword-card ${stateClass}">
            <div class="keyword-header">
                <div class="keyword-title-row">
                    <div class="keyword-title">
                        ${escapeHtml(k.keyword)}
                        ${rankBadge}
                        <span class="area-badge area-${area}">${areaLabel}</span>
                    </div>
                </div>
            </div>
            <div class="keyword-url" title="${escapeHtml(k.target_url || '')}">
                🔗 ${escapeHtml(shortUrl(k.target_url))}
            </div>
            <div class="keyword-meta">${metaHtml}</div>
            ${actionsHtml}
        </div>
    `;
}

function bindKeywordCardEvents(container) {
    container.querySelectorAll(".kw-action-btn").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const kwId = parseInt(btn.dataset.kwId, 10);
            const ownerUserId = btn.dataset.owner || null;
            
            if (action === "capture") await openCaptureViewer(kwId, ownerUserId);
            else if (action === "check") await toggleManualCheck(kwId, ownerUserId, btn);
            else if (action === "share") await openShareModal(kwId, ownerUserId);
        });
    });
}

// ================================================================
// 캡처 뷰어
// ================================================================

async function openCaptureViewer(kwId, ownerUserId = null) {
    // 키워드 찾기
    const kw = findKeyword(kwId, ownerUserId);
    if (!kw) {
        showToast("키워드를 찾을 수 없어요", "error");
        return;
    }
    
    // 캡처 파일명 — 우선 oneshot first_screenshot, 없으면 latest result screenshot
    let filename = kw.oneshot_first_screenshot;
    let userId = kw.user_id || (ownerUserId || Session.user()?.id);
    
    if (!filename && kw.last_rank > 0) {
        // results에서 직접 가져오기
        try {
            const r = await DB.select("results", {
                filters: { keyword_id: `eq.${kwId}` },
                order: "id.desc",
                limit: 1,
            });
            if (r.ok && r.data?.[0]) {
                filename = r.data[0].screenshot;
                userId = r.data[0].user_id || userId;
            }
        } catch (e) {}
    }
    
    if (!filename) {
        showToast("캡처가 없어요", "warn");
        return;
    }
    
    $("#capture-viewer-title").textContent = kw.keyword;
    $("#capture-viewer-img").src = "";
    $("#capture-viewer").classList.remove("hidden");
    
    try {
        const url = await Storage.getCaptureUrl(filename, userId);
        $("#capture-viewer-img").src = url;
    } catch (err) {
        showToast("캡처 로드 실패", "error");
        $("#capture-viewer").classList.add("hidden");
    }
}

function closeCaptureViewer() {
    $("#capture-viewer").classList.add("hidden");
    $("#capture-viewer-img").src = "";
}

// ================================================================
// 노출 완료 마킹 (체크)
// ================================================================

async function toggleManualCheck(kwId, ownerUserId, btn) {
    const kw = findKeyword(kwId, ownerUserId);
    if (!kw) return;
    
    if (kw.oneshot_first_exposed_at) {
        // 이미 완료 — 토글 해제 가능?
        const ok = confirm("이미 노출 완료로 체크되어 있어요. 해제할까요?");
        if (!ok) return;
        
        try {
            const r = await DB.update("oneshot_jobs", {
                state: "pending",
                first_exposed_at: null,
                first_rank: null,
                first_screenshot: null,
            }, { keyword_id: `eq.${kwId}` });
            
            if (!r.ok) throw new Error(r.error || "수정 권한이 없어요");
            
            kw.oneshot_first_exposed_at = null;
            kw.oneshot_first_rank = null;
            kw.oneshot_first_screenshot = null;
            kw.oneshot_state = "pending";
            
            showToast("체크 해제됨", "success", 1500);
            refreshCurrentScreen();
        } catch (e) {
            showToast("해제 실패: " + (e.message || ""), "error");
        }
    } else {
        // 노출 완료 마킹 — 사용자 입력 순위
        const rank = prompt("노출된 순위는? (예: 1, 2, 3)", "1");
        if (rank === null) return;
        const rankNum = parseInt(rank, 10);
        if (isNaN(rankNum) || rankNum < 1) {
            showToast("올바른 순위를 입력해주세요", "warn");
            return;
        }
        
        btn.disabled = true;
        try {
            const now = new Date().toISOString();
            const patch = {
                state: "exposed",
                first_exposed_at: now,
                first_rank: rankNum,
            };
            
            // 1) 기존 row 있나 체크
            const existing = await DB.select("oneshot_jobs", {
                filters: { keyword_id: `eq.${kwId}` },
                limit: 1,
            });
            
            if (existing.ok && existing.data && existing.data.length > 0) {
                // update
                const r = await DB.update("oneshot_jobs", patch, { keyword_id: `eq.${kwId}` });
                if (!r.ok) throw new Error(r.error || "수정 권한이 없어요");
            } else {
                // insert (그룹의 user_id 가져와야 함)
                const userId = kw.user_id || ownerUserId || Session.user()?.id;
                const r = await DB.insert("oneshot_jobs", {
                    keyword_id: kwId,
                    user_id: userId,
                    ...patch,
                }, { return: false });
                if (!r.ok) throw new Error(r.error || "추가 권한이 없어요");
            }
            
            kw.oneshot_first_exposed_at = now;
            kw.oneshot_first_rank = rankNum;
            kw.oneshot_state = "exposed";
            
            showToast("노출 완료 ✅", "success");
            refreshCurrentScreen();
        } catch (e) {
            showToast("저장 실패: " + (e.message || ""), "error");
        } finally {
            btn.disabled = false;
        }
    }
}

function findKeyword(kwId, ownerUserId = null) {
    if (ownerUserId) {
        const adv = State.advertiserGroups.find(a => a.profile.user_id === ownerUserId);
        if (!adv) return null;
        for (const g of adv.groups) {
            const k = (g.keywords || []).find(x => x.id === kwId);
            if (k) return k;
        }
        return null;
    }
    return State.keywords.find(k => k.id === kwId);
}

function refreshCurrentScreen() {
    if (State.currentTab === "group-detail") renderGroupDetail();
    else if (State.currentTab === "home") renderHome();
}

// ================================================================
// 카톡 공유 — 단일 키워드
// ================================================================

async function openShareModal(kwId, ownerUserId = null) {
    const kw = findKeyword(kwId, ownerUserId);
    if (!kw) {
        showToast("키워드를 찾을 수 없어요", "error");
        return;
    }
    
    const userId = kw.user_id || ownerUserId || Session.user()?.id;
    
    // 텍스트 양식
    const area = AREA_LABEL[inferArea(kw.target_url)] || "사이트";
    const rank = kw.oneshot_first_rank || kw.last_rank || "-";
    const url = ensureUrl(kw.target_url);
    const checkAt = kw.oneshot_first_exposed_at || kw.last_check_at;
    
    const title = `📊 ${kw.keyword} — ${rank}등 (${area})`;
    const body = `✅ 노출 확인\n📌 ${url}\n⏰ ${fmtDateTime(checkAt)}`;
    const fullText = `${title}\n\n${body}`;
    
    $("#share-preview-title").textContent = title;
    $("#share-preview-body").textContent = body;
    
    // 캡처 이미지 미리보기
    const imgGrid = $("#share-preview-imgs");
    imgGrid.innerHTML = "";
    
    let captureFilename = kw.oneshot_first_screenshot;
    if (!captureFilename && kw.last_rank > 0) {
        try {
            const r = await DB.select("results", {
                filters: { keyword_id: `eq.${kwId}` },
                order: "id.desc",
                limit: 1,
            });
            if (r.ok && r.data?.[0]) captureFilename = r.data[0].screenshot;
        } catch {}
    }
    
    let captureUrl = null;
    if (captureFilename) {
        try {
            captureUrl = await Storage.getCaptureUrl(captureFilename, userId);
            const div = document.createElement("div");
            div.className = "share-preview-img";
            div.innerHTML = `<img src="${captureUrl}" alt="캡처">`;
            imgGrid.appendChild(div);
        } catch {}
    }
    
    // 모달 열기
    openModal("share-modal");
    
    // 버튼 핸들러
    const sendBtn = $("#share-send-btn");
    const copyBtn = $("#share-copy-btn");
    
    sendBtn.onclick = async () => {
        await shareViaWebApi({
            title: title,
            text: fullText,
            captureUrl: captureUrl,
            captureFilename: captureFilename,
        });
    };
    copyBtn.onclick = () => copyToClipboard(fullText);
}

// ================================================================
// 카톡 공유 — 그룹 전체 (건바이 보고)
// ================================================================

async function openGroupShareModal(group, keywords, ownerUserId = null) {
    State._currentShareKeywords = keywords;
    State._currentShareOwnerUserId = ownerUserId;
    State._currentShareGroup = group;
    
    // 분류
    const stable = keywords.filter(k => classifyKeyword(k) === "stable");
    const awaiting = keywords.filter(k => classifyKeyword(k) === "awaiting");
    const action = keywords.filter(k => classifyKeyword(k) === "action");
    
    // 미리 — 체크박스 리스트로 보여줌
    const body = $("#group-share-body");
    let html = `
        <div class="form-group">
            <label class="form-label">포함할 키워드 선택</label>
            <div class="checkbox-list" id="grp-share-checkbox-list">
    `;
    
    // 노출 완료된 것만 기본 체크
    [...stable, ...awaiting].forEach(k => {
        const area = AREA_LABEL[inferArea(k.target_url)] || "사이트";
        const rank = k.oneshot_first_rank || k.last_rank || "-";
        html += `
            <label class="checkbox-row checked" data-kw-id="${k.id}">
                <input type="checkbox" checked data-kw-id="${k.id}">
                <div class="checkbox-row-content">
                    <div class="checkbox-row-title">${escapeHtml(k.keyword)} <span style="color: var(--color-success-text); font-size: 12px;">(${rank}등)</span></div>
                    <div class="checkbox-row-meta">${area} · ${shortUrl(k.target_url, 28)}</div>
                </div>
            </label>
        `;
    });
    
    if (action.length > 0) {
        action.forEach(k => {
            const area = AREA_LABEL[inferArea(k.target_url)] || "사이트";
            html += `
                <label class="checkbox-row" data-kw-id="${k.id}">
                    <input type="checkbox" data-kw-id="${k.id}">
                    <div class="checkbox-row-content">
                        <div class="checkbox-row-title">${escapeHtml(k.keyword)} <span style="color: var(--color-danger-text); font-size: 12px;">(미노출)</span></div>
                        <div class="checkbox-row-meta">${area} · ${shortUrl(k.target_url, 28)}</div>
                    </div>
                </label>
            `;
        });
    }
    
    html += `</div></div>
        <div class="form-group">
            <label class="form-label">미리보기</label>
            <div class="share-preview">
                <div class="share-preview-card">
                    <div class="share-preview-title" id="grp-share-preview-title"></div>
                    <div class="share-preview-body" id="grp-share-preview-body"></div>
                </div>
            </div>
        </div>
    `;
    
    body.innerHTML = html;
    
    // 체크박스 이벤트
    body.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener("change", () => {
            cb.closest(".checkbox-row").classList.toggle("checked", cb.checked);
            updateGroupSharePreview();
        });
    });
    
    updateGroupSharePreview();
    openModal("group-share-modal");
    
    // 버튼 핸들러
    $("#group-share-send-btn").onclick = sendGroupShare;
    $("#group-share-copy-btn").onclick = () => {
        const text = buildGroupShareText();
        if (text) copyToClipboard(text);
    };
}

function getSelectedShareKeywords() {
    const ids = [];
    $$('#grp-share-checkbox-list input:checked').forEach(cb => {
        ids.push(parseInt(cb.dataset.kwId, 10));
    });
    return State._currentShareKeywords.filter(k => ids.includes(k.id));
}

function buildGroupShareText() {
    const selected = getSelectedShareKeywords();
    const group = State._currentShareGroup;
    if (selected.length === 0) return "";
    
    const today = new Date();
    const dateStr = `${today.getMonth() + 1}/${today.getDate()}`;
    const title = `📊 ${group.name} — ${dateStr} 보고`;
    
    let lines = [title, "━━━━━━━━━━━━━━"];
    
    selected.forEach((k, i) => {
        const area = AREA_LABEL[inferArea(k.target_url)] || "사이트";
        const rank = k.oneshot_first_rank || k.last_rank;
        const state = classifyKeyword(k);
        const url = ensureUrl(k.target_url);
        const checkAt = k.oneshot_first_exposed_at || k.last_check_at;
        
        const stateIcon = state === "stable" ? "✅" : state === "awaiting" ? "⏳" : "🚨";
        const rankText = rank > 0 ? `${rank}등` : "미노출";
        
        lines.push("");
        lines.push(`${i + 1}. ${stateIcon} ${k.keyword} — ${rankText} (${area})`);
        lines.push(`📌 ${url}`);
        if (checkAt) lines.push(`⏰ ${fmtDateTime(checkAt)}`);
    });
    
    lines.push("");
    lines.push("━━━━━━━━━━━━━━");
    lines.push(`총 ${selected.length}개 키워드`);
    
    return lines.join("\n");
}

function updateGroupSharePreview() {
    const text = buildGroupShareText();
    const titleEl = $("#grp-share-preview-title");
    const bodyEl = $("#grp-share-preview-body");
    if (!text) {
        titleEl.textContent = "(키워드를 선택해주세요)";
        bodyEl.textContent = "";
        return;
    }
    const lines = text.split("\n");
    titleEl.textContent = lines[0];
    bodyEl.textContent = lines.slice(1).join("\n");
}

async function sendGroupShare() {
    const selected = getSelectedShareKeywords();
    if (selected.length === 0) {
        showToast("키워드를 선택해주세요", "warn");
        return;
    }
    
    const text = buildGroupShareText();
    
    // 캡처 파일들 모으기
    const ownerUserId = State._currentShareOwnerUserId;
    const captureFiles = [];
    
    const sendBtn = $("#group-share-send-btn");
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<span class="spinner-inline"></span> 준비 중...';
    
    try {
        for (const k of selected) {
            const userId = k.user_id || ownerUserId || Session.user()?.id;
            let filename = k.oneshot_first_screenshot;
            if (!filename && k.last_rank > 0) {
                try {
                    const r = await DB.select("results", {
                        filters: { keyword_id: `eq.${k.id}` },
                        order: "id.desc",
                        limit: 1,
                    });
                    if (r.ok && r.data?.[0]) filename = r.data[0].screenshot;
                } catch {}
            }
            
            if (filename) {
                try {
                    const url = await Storage.getCaptureUrl(filename, userId);
                    const blob = await fetch(url).then(r => r.blob());
                    const file = new File([blob], `${k.keyword}.png`, { type: blob.type || "image/png" });
                    captureFiles.push(file);
                } catch (e) {
                    console.warn(`캡처 다운로드 실패 (${k.keyword}):`, e);
                }
            }
        }
        
        // Web Share API 시도
        await shareViaWebApi({
            title: text.split("\n")[0],
            text: text,
            files: captureFiles,
        });
        
        closeModal("group-share-modal");
    } catch (e) {
        showToast("공유 실패: " + e.message, "error");
    } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '📲 공유하기';
    }
}

// ================================================================
// Web Share API 핵심 함수
// ================================================================

async function shareViaWebApi({ title, text, captureUrl, captureFilename, files }) {
    // files 우선 — 직접 전달된 경우
    let shareFiles = files || [];
    
    // captureUrl 만 있으면 다운로드
    if ((!shareFiles || shareFiles.length === 0) && captureUrl) {
        try {
            const blob = await fetch(captureUrl).then(r => r.blob());
            const file = new File([blob], captureFilename || "capture.png", { type: blob.type || "image/png" });
            shareFiles = [file];
        } catch (e) {
            console.warn("캡처 다운로드 실패:", e);
        }
    }
    
    const shareData = {
        title: title,
        text: text,
    };
    
    if (shareFiles.length > 0) {
        shareData.files = shareFiles;
    }
    
    // Web Share API 시도
    if (navigator.share) {
        try {
            // 파일 공유 가능한지 체크
            if (shareData.files && navigator.canShare && !navigator.canShare({ files: shareData.files })) {
                console.warn("파일 공유 불가 — 텍스트만 공유");
                delete shareData.files;
            }
            
            await navigator.share(shareData);
            showToast("공유 완료", "success", 1500);
            return true;
        } catch (e) {
            if (e.name === "AbortError") {
                // 사용자가 취소 — 정상
                return false;
            }
            console.warn("Web Share 실패:", e);
            // 폴백
        }
    }
    
    // 폴백 — 텍스트 클립보드 복사
    return copyToClipboard(text);
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
        } else {
            // 폴백
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
        }
        showToast("📋 복사됨 — 카톡에 붙여넣기 해주세요", "success", 2500);
        return true;
    } catch (e) {
        showToast("복사 실패", "error");
        return false;
    }
}

// ================================================================
// 화면: 월보장 (매트릭스)
// ================================================================

async function renderMatrix() {
    // 월보장 그룹 셀렉트
    const sel = $("#matrix-group-filter");
    const monthlyGroups = State.groups.filter(g => g.mode === "monthly");
    
    // 광고주 월보장 그룹도 포함
    const advMonthlyGroups = [];
    if (State.isAdmin) {
        for (const adv of State.advertiserGroups) {
            for (const g of adv.groups) {
                if (g.mode === "monthly") {
                    advMonthlyGroups.push({ ...g, _ownerEmail: adv.profile.email, _ownerUserId: adv.profile.user_id });
                }
            }
        }
    }
    
    let opts = '<option value="">그룹을 선택해주세요</option>';
    if (monthlyGroups.length > 0) {
        opts += '<optgroup label="내 그룹">';
        monthlyGroups.forEach(g => {
            opts += `<option value="${g.id}">${escapeHtml(g.name)}</option>`;
        });
        opts += '</optgroup>';
    }
    if (advMonthlyGroups.length > 0) {
        opts += '<optgroup label="광고주 그룹">';
        advMonthlyGroups.forEach(g => {
            opts += `<option value="${g.id}" data-owner="${g._ownerUserId}">${escapeHtml(g._ownerEmail)} / ${escapeHtml(g.name)}</option>`;
        });
        opts += '</optgroup>';
    }
    sel.innerHTML = opts;
    
    if (State.matrixGroupId) {
        sel.value = State.matrixGroupId;
    }
    
    sel.onchange = () => {
        State.matrixGroupId = sel.value ? parseInt(sel.value, 10) : null;
        renderMatrixContent();
    };
    
    renderMatrixContent();
}

async function renderMatrixContent() {
    const content = $("#matrix-content");
    
    if (!State.matrixGroupId) {
        content.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📊</div>
                <div class="empty-state-title">그룹을 선택해주세요</div>
                <div>월보장 그룹의 7일 노출 매트릭스를 볼 수 있어요</div>
            </div>
        `;
        return;
    }
    
    content.innerHTML = `<div class="empty-state"><div class="spinner" style="margin: 0 auto;"></div></div>`;
    
    // 그룹 + 키워드
    const sel = $("#matrix-group-filter");
    const ownerUserId = sel.options[sel.selectedIndex]?.dataset.owner || null;
    const data = getGroupAndKeywords(State.matrixGroupId, ownerUserId);
    if (!data) {
        content.innerHTML = `<div class="empty-state"><div class="empty-state-title">그룹을 찾을 수 없어요</div></div>`;
        return;
    }
    const { group, keywords } = data;
    
    if (keywords.length === 0) {
        content.innerHTML = `<div class="empty-state"><div class="empty-state-title">키워드가 없어요</div></div>`;
        return;
    }
    
    // 7일 매트릭스 데이터
    let matrix;
    try {
        matrix = await API.sevenDayMatrix(keywords.map(k => k.id));
    } catch (e) {
        content.innerHTML = `<div class="empty-state"><div class="empty-state-title">매트릭스 로드 실패</div></div>`;
        return;
    }
    
    // 7일 라벨 (오늘 - 6 ~ 오늘)
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        dates.push({
            iso: d.toISOString().slice(0, 10),
            label: `${d.getMonth() + 1}/${d.getDate()}`,
        });
    }
    
    // 통계
    const totalExposed = keywords.filter(k => (k.last_rank ?? 0) > 0).length;
    
    let html = `
        <div class="page-header" style="margin-bottom: var(--space-3);">
            <div>
                <div style="font-size: 16px; font-weight: 600;">${escapeHtml(group.name)}</div>
                <div class="page-subtitle">${keywords.length}개 키워드 · 현재 ${totalExposed}개 노출</div>
            </div>
        </div>
        <div class="matrix-container">
            <table class="matrix-table">
                <thead>
                    <tr>
                        <th class="kw-col">키워드</th>
                        ${dates.map(d => `<th>${d.label}</th>`).join("")}
                    </tr>
                </thead>
                <tbody>
    `;
    
    for (const k of keywords) {
        const cells = matrix[k.id] || {};
        html += `<tr>
            <td class="kw-col" title="${escapeHtml(k.keyword)}">${escapeHtml(k.keyword)}</td>`;
        for (const d of dates) {
            const cell = cells[d.iso];
            html += `<td>${renderMatrixCell(cell)}</td>`;
        }
        html += `</tr>`;
    }
    
    html += `</tbody></table></div>`;
    
    // 범례
    html += `
        <div style="display: flex; gap: var(--space-3); flex-wrap: wrap; margin-top: var(--space-3); padding: 0 var(--space-2); font-size: 12px; color: var(--color-text-secondary);">
            <div style="display: flex; align-items: center; gap: 6px;"><span class="matrix-cell exposed" style="min-width: 20px; height: 20px; font-size: 10px;">N</span> 자동 노출 (순위)</div>
            <div style="display: flex; align-items: center; gap: 6px;"><span class="matrix-cell exposed-manual" style="min-width: 20px; height: 20px; font-size: 10px;">✓</span> 수동 체크</div>
            <div style="display: flex; align-items: center; gap: 6px;"><span class="matrix-cell not-exposed" style="min-width: 20px; height: 20px; font-size: 10px;">×</span> 미노출</div>
            <div style="display: flex; align-items: center; gap: 6px;"><span class="matrix-cell no-check" style="min-width: 20px; height: 20px; font-size: 10px;">−</span> 검사 없음</div>
        </div>
    `;
    
    content.innerHTML = html;
}

function renderMatrixCell(cell) {
    if (!cell) {
        return `<span class="matrix-cell no-check">−</span>`;
    }
    if (cell.manual) {
        return `<span class="matrix-cell exposed-manual">✓</span>`;
    }
    if (cell.exposed && cell.rank > 0) {
        return `<span class="matrix-cell exposed">${cell.rank}</span>`;
    }
    return `<span class="matrix-cell not-exposed">×</span>`;
}

// ================================================================
// 화면: 설정
// ================================================================

function renderSettings() {
    const profile = State.profile || {};
    const user = Session.user() || {};
    
    $("#settings-email").textContent = user.email || "-";
    
    const planNames = { trial: "체험", basic: "베이직", pro: "프로", enterprise: "엔터프라이즈" };
    $("#settings-plan").textContent = (profile.is_admin ? "👑 관리자" : (planNames[profile.plan_name] || profile.plan_name || "-"));
    
    if (profile.expires_at) {
        const d = new Date(profile.expires_at);
        $("#settings-expires").textContent = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
    } else {
        $("#settings-expires").textContent = profile.is_admin ? "무제한" : "-";
    }
    
    const totalKws = State.keywords.length;
    const maxKws = profile.max_keywords ?? "-";
    $("#settings-keywords").textContent = `${totalKws} / ${maxKws}`;
    $("#settings-groups").textContent = `${State.groups.length} / ${profile.max_groups ?? "-"}`;
}

// ================================================================
// 모달
// ================================================================

function openModal(id) {
    $("#" + id).classList.remove("hidden");
}

function closeModal(id) {
    $("#" + id).classList.add("hidden");
}

function bindModalCloseHandlers() {
    document.addEventListener("click", (e) => {
        const target = e.target.closest("[data-close]");
        if (target) {
            const id = target.dataset.close;
            closeModal(id);
        }
    });
}

// ================================================================
// 그룹 모달
// ================================================================

function openGroupModal(group = null) {
    const isEdit = !!group;
    $("#group-modal-title").textContent = isEdit ? "그룹 편집" : "새 그룹";
    
    $("#g-name").value = group?.name || "";
    $("#g-slot-limit").value = group?.slot_limit || "";
    
    // 모드 세그먼트
    const mode = group?.mode || "monthly";
    $$("#g-mode-seg .segmented-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.mode === mode);
    });
    updateGroupModalHelp(mode);
    
    // 모드 변경 (편집 시 막기)
    $$("#g-mode-seg .segmented-btn").forEach(b => {
        b.disabled = isEdit;
        b.style.opacity = isEdit ? "0.5" : "1";
        b.onclick = () => {
            if (isEdit) return;
            $$("#g-mode-seg .segmented-btn").forEach(x => x.classList.remove("active"));
            b.classList.add("active");
            updateGroupModalHelp(b.dataset.mode);
        };
    });
    
    State._editingGroup = group;
    openModal("group-modal");
}

function updateGroupModalHelp(mode) {
    const help = $("#g-mode-help");
    if (mode === "monthly") {
        help.textContent = "월보장: 매일 자동 검사하며 노출 추적";
    } else {
        help.textContent = "건바이: 노출 후 24시간 검증하는 단발성 검사";
    }
}

async function saveGroup() {
    const name = $("#g-name").value.trim();
    if (!name) {
        showToast("그룹명을 입력해주세요", "warn");
        return;
    }
    
    const activeSeg = $("#g-mode-seg .segmented-btn.active");
    const mode = activeSeg?.dataset.mode || "monthly";
    const slotLimit = parseInt($("#g-slot-limit").value, 10) || 0;
    
    const btn = $("#group-save-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> 저장 중...';
    
    try {
        if (State._editingGroup) {
            await API.updateGroup(State._editingGroup.id, { name, slot_limit: slotLimit });
            showToast("저장됨", "success");
        } else {
            await API.addGroup({ name, mode, slot_limit: slotLimit });
            showToast("그룹 만들어졌어요", "success");
        }
        closeModal("group-modal");
        await loadAllData();
        renderGroups();
    } catch (e) {
        showToast(e.message || "저장 실패", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "저장";
        State._editingGroup = null;
    }
}

// ================================================================
// 키워드 모달
// ================================================================

function openKeywordModal(groupId) {
    State._addingKwGroupId = groupId;
    $("#kw-keyword").value = "";
    $("#kw-url").value = "";
    $("#kw-capture").checked = true;
    openModal("kw-modal");
    setTimeout(() => $("#kw-keyword").focus(), 200);
}

async function saveKeyword() {
    const keyword = $("#kw-keyword").value.trim();
    const url = $("#kw-url").value.trim();
    const capture = $("#kw-capture").checked;
    const groupId = State._addingKwGroupId;
    
    if (!keyword) { showToast("키워드를 입력해주세요", "warn"); return; }
    if (!url) { showToast("URL을 입력해주세요", "warn"); return; }
    
    const btn = $("#kw-save-btn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-inline"></span> 추가 중...';
    
    try {
        await API.addKeyword({ keyword, target_url: url, capture, group_id: groupId });
        showToast("키워드 추가됨", "success");
        closeModal("kw-modal");
        await loadAllData();
        if (State.currentTab === "group-detail") renderGroupDetail();
    } catch (e) {
        showToast(e.message || "추가 실패", "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "추가";
    }
}

// ================================================================
// 이벤트 바인딩
// ================================================================

function bindEvents() {
    // 로그인
    $("#login-form").addEventListener("submit", handleLogin);
    
    // 새로고침
    $("#refresh-btn").addEventListener("click", handleRefresh);
    
    // 백 버튼
    $("#header-back-btn").addEventListener("click", goBack);
    
    // 하단 탭
    $$(".bottom-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            const t = tab.dataset.tab;
            if (t && t !== "more") navigate(t);
        });
    });
    
    // 새 그룹
    $("#btn-new-group").addEventListener("click", () => openGroupModal());
    $("#group-save-btn").addEventListener("click", saveGroup);
    $("#kw-save-btn").addEventListener("click", saveKeyword);
    
    // 홈에서 그룹으로
    $("#home-go-groups").addEventListener("click", () => navigate("groups"));
    
    // 로그아웃
    $("#settings-logout").addEventListener("click", handleLogout);
    
    // 카카오톡 문의
    $("#settings-kakao-row").addEventListener("click", () => {
        copyToClipboard("congsin");
        showToast("카카오톡 ID 복사됨 → 친구 추가하세요", "success", 3000);
    });
    
    // 캡처 뷰어
    $("#capture-viewer-close").addEventListener("click", closeCaptureViewer);
    
    // 모달 닫기
    bindModalCloseHandlers();
}

// ================================================================
// 시작
// ================================================================

document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    init();
});
