// ============================================================
// Supabase 설정 + HTTP 통신 래퍼
// ============================================================
//
// PC앱의 supabase_client.py와 동일한 동작.
// 외부 라이브러리 없이 fetch API만 사용 (의존성 X).
//
// publishable key는 클라이언트에 노출돼도 안전 (RLS가 보안 담당).

const SUPABASE_URL = "https://yisaqdwtudxrqivnqacz.supabase.co";
const SUPABASE_KEY = "sb_publishable_JCEa0-wSZwOIYPlBUKuxtA_5wFMfZ0_";

// 세션 저장 키 (localStorage)
const SESSION_STORAGE_KEY = "rankpilot_session";

// ============================================================
// 세션 관리
// ============================================================

const Session = {
    /** 현재 세션 로드 (localStorage). 없으면 null. */
    load() {
        try {
            const raw = localStorage.getItem(SESSION_STORAGE_KEY);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (!s || !s.access_token) return null;
            return s;
        } catch (e) {
            return null;
        }
    },

    /** 세션 저장. */
    save(session) {
        try {
            localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
        } catch (e) {
            console.error("세션 저장 실패:", e);
        }
    },

    /** 세션 삭제 (로그아웃). */
    clear() {
        try {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (e) { }
    },

    /** 현재 access_token. 없으면 null. */
    token() {
        const s = this.load();
        return s ? s.access_token : null;
    },

    /** 현재 사용자 정보. 없으면 null. */
    user() {
        const s = this.load();
        return s ? s.user : null;
    },

    /** access_token이 만료됐나? (5분 여유) */
    isExpired() {
        const s = this.load();
        if (!s || !s.expires_at) return true;
        const now = Math.floor(Date.now() / 1000);
        return s.expires_at - 300 < now;
    },
};


// ============================================================
// HTTP 저수준
// ============================================================

async function _request(method, path, body, opts = {}) {
    const url = `${SUPABASE_URL}${path}`;
    const headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(opts.headers || {}),
    };

    // 토큰 자동 첨부 (auth 엔드포인트가 아니면)
    const token = opts.token !== undefined ? opts.token : Session.token();
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    const init = { method, headers };
    if (body !== undefined && body !== null) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    try {
        const resp = await fetch(url, init);
        const text = await resp.text();
        let data = null;
        if (text) {
            try { data = JSON.parse(text); }
            catch { data = { _raw: text.slice(0, 500) }; }
        }
        return { status: resp.status, data, ok: resp.ok };
    } catch (e) {
        return { status: 0, data: { error: "network", message: String(e) }, ok: false };
    }
}


// ============================================================
// Auth API
// ============================================================

const Auth = {
    /** 이메일/비번 로그인. 성공 시 세션 저장 + 리턴. */
    async login(email, password) {
        const res = await _request(
            "POST",
            "/auth/v1/token?grant_type=password",
            { email, password },
            { token: null }
        );

        if (res.status === 200 && res.data && res.data.access_token) {
            Session.save(res.data);
            return { ok: true, session: res.data };
        }

        return {
            ok: false,
            error: this._translateError(res.status, res.data),
        };
    },

    /** access_token 갱신. */
    async refresh() {
        const s = Session.load();
        if (!s || !s.refresh_token) return { ok: false, error: "리프레시 토큰 없음" };

        const res = await _request(
            "POST",
            "/auth/v1/token?grant_type=refresh_token",
            { refresh_token: s.refresh_token },
            { token: null }
        );

        if (res.status === 200 && res.data && res.data.access_token) {
            Session.save(res.data);
            return { ok: true, session: res.data };
        }
        return { ok: false, error: this._translateError(res.status, res.data) };
    },

    /** 로그아웃. */
    async logout() {
        const token = Session.token();
        if (token) {
            await _request("POST", "/auth/v1/logout", null);
        }
        Session.clear();
        return { ok: true };
    },

    /** 현재 토큰의 사용자 정보 조회 (검증). */
    async getUser() {
        const res = await _request("GET", "/auth/v1/user", null);
        if (res.status === 200 && res.data && res.data.id) {
            return { ok: true, user: res.data };
        }
        return { ok: false, error: this._translateError(res.status, res.data) };
    },

    /** 토큰 만료 확인 + 자동 갱신. */
    async ensureValidToken() {
        const s = Session.load();
        if (!s) return false;
        if (Session.isExpired()) {
            const r = await this.refresh();
            return r.ok;
        }
        return true;
    },

    _translateError(status, body) {
        if (status === 0) return "서버에 연결할 수 없어요. 인터넷 확인해주세요.";
        const msg = ((body && (body.msg || body.error_description || body.message)) || "").toLowerCase();
        if (status === 400) return "이메일 또는 비밀번호가 올바르지 않아요.";
        if (status === 429) return "로그인 시도가 너무 많아요. 잠시 후 다시 시도해주세요.";
        if (status === 401) return "로그인 세션이 만료되었어요.";
        if (msg) return `로그인 실패: ${msg}`;
        return `로그인 실패 (코드 ${status})`;
    },
};


// ============================================================
// DB API (PostgREST) — table_select / insert / update / delete
// ============================================================

const DB = {
    /** SELECT */
    async select(table, opts = {}) {
        // 토큰 자동 갱신
        await Auth.ensureValidToken();

        const params = new URLSearchParams();
        params.set("select", opts.columns || "*");
        if (opts.filters) {
            for (const [k, v] of Object.entries(opts.filters)) {
                params.append(k, v);
            }
        }
        if (opts.order) params.set("order", opts.order);
        if (opts.limit !== undefined) params.set("limit", String(opts.limit));

        const headers = {};
        if (opts.single) headers["Accept"] = "application/vnd.pgrst.object+json";

        const res = await _request("GET", `/rest/v1/${table}?${params}`, null, { headers });

        if (res.ok) {
            if (opts.single) {
                return { ok: true, data: typeof res.data === "object" && !Array.isArray(res.data) ? res.data : null };
            }
            return { ok: true, data: Array.isArray(res.data) ? res.data : [] };
        }
        if (opts.single && res.status === 406) {
            return { ok: true, data: null };
        }
        return { ok: false, status: res.status, error: this._translateError(res.status, res.data) };
    },

    /** INSERT */
    async insert(table, rows, opts = {}) {
        await Auth.ensureValidToken();
        const headers = {
            "Prefer": opts.return === false ? "return=minimal" : "return=representation",
        };
        const res = await _request("POST", `/rest/v1/${table}`, rows, { headers });
        if (res.ok) {
            return {
                ok: true,
                data: Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []),
            };
        }
        return { ok: false, status: res.status, error: this._translateError(res.status, res.data) };
    },

    /** UPDATE */
    async update(table, patch, filters, opts = {}) {
        await Auth.ensureValidToken();
        if (!filters || Object.keys(filters).length === 0) {
            return { ok: false, error: "안전을 위해 update에는 반드시 필터가 필요해요" };
        }
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) {
            params.append(k, v);
        }
        const headers = {
            "Prefer": opts.return === false ? "return=minimal" : "return=representation",
        };
        const res = await _request("PATCH", `/rest/v1/${table}?${params}`, patch, { headers });
        if (res.ok) {
            return { ok: true, data: Array.isArray(res.data) ? res.data : [] };
        }
        return { ok: false, status: res.status, error: this._translateError(res.status, res.data) };
    },

    /** DELETE */
    async delete(table, filters) {
        await Auth.ensureValidToken();
        if (!filters || Object.keys(filters).length === 0) {
            return { ok: false, error: "안전을 위해 delete에는 반드시 필터가 필요해요" };
        }
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(filters)) {
            params.append(k, v);
        }
        const res = await _request("DELETE", `/rest/v1/${table}?${params}`, null);
        if (res.ok) return { ok: true };
        return { ok: false, status: res.status, error: this._translateError(res.status, res.data) };
    },

    _translateError(status, body) {
        if (status === 0) return "서버에 연결할 수 없어요";
        if (status === 401) return "로그인이 만료되었어요. 다시 로그인해주세요.";
        if (status === 403) return "권한이 없어요";
        if (status === 404) return "데이터를 찾을 수 없어요";
        if (body && body.code === "23505") return "이미 같은 이름이 있어요";
        if (body && body.message) return `DB 오류: ${body.message.slice(0, 80)}`;
        return `DB 오류 (코드 ${status})`;
    },
};


// ============================================================
// Storage API (PC앱의 storage_get_url과 호환)
// ============================================================
//
// 캡처 사진은 'captures' 버킷에 저장됨. 경로 형식: {user_id}/{filename}
// PC앱의 _storage_path_for() 와 일치해야 함.
//
// 한글 파일명은 SHA256 해시로 변환됨 (PC앱과 동일).
// Supabase Storage는 파일 키에 ASCII만 받음.
// ============================================================

/** 한글/특수문자 파일명 → ASCII safe (PC앱의 _ascii_safe_filename과 동일).
 *  같은 입력은 항상 같은 출력 (deterministic).
 */
async function _asciiSafeFilename(filename) {
    // 이미 ASCII만으로 된 파일명이면 그대로
    if (/^[\x00-\x7F]*$/.test(filename)) {
        return filename;
    }
    // 한글 등 포함 → SHA256 해시 (앞 24자) + 원래 확장자
    let base, ext;
    const dotIdx = filename.lastIndexOf(".");
    if (dotIdx > 0) {
        base = filename.slice(0, dotIdx);
        ext = filename.slice(dotIdx + 1);
    } else {
        base = filename;
        ext = "";
    }

    // UTF-8 바이트로 인코딩 후 SHA-256
    const enc = new TextEncoder();
    const bytes = enc.encode(filename);  // PC앱과 동일 — 전체 filename을 해시
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArr = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArr.map(b => b.toString(16).padStart(2, "0")).join("");

    const safe = hashHex.slice(0, 24);
    return ext ? `${safe}.${ext}` : safe;
}

const Storage = {
    /** Signed URL 생성 (60분 유효).
     *
     *  filename: results.screenshot 필드 값 (예: "kw_123_xxx.png" 또는 "한글_파일.png")
     *  userId:   해당 결과의 user_id (다른 사용자 캡처 보려면 필수)
     *            null이면 현재 로그인한 사용자 user_id 사용
     */
    async getCaptureUrl(filename, userId = null, expiresInSec = 3600) {
        if (!filename) return null;
        await Auth.ensureValidToken();

        // 경로 만들기
        let storagePath;
        if (filename.includes("/")) {
            // 이미 user_id/filename 형식 — filename 부분만 ASCII safe하게
            const slashIdx = filename.indexOf("/");
            const dirPart = filename.slice(0, slashIdx);
            const filePart = filename.slice(slashIdx + 1);
            const safeFile = await _asciiSafeFilename(filePart);
            storagePath = `${dirPart}/${safeFile}`;
        } else {
            // filename만 있음 → user_id 앞에 붙이기 + 한글이면 해시
            const uid = userId || Session.user()?.id;
            if (!uid) {
                console.warn("Storage: user_id를 찾을 수 없어요");
                return null;
            }
            const safeFile = await _asciiSafeFilename(filename);
            storagePath = `${uid}/${safeFile}`;
        }

        const url = `${SUPABASE_URL}/storage/v1/object/sign/captures/${storagePath}`;
        const session = Session.load();

        try {
            const resp = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "apikey": SUPABASE_KEY,
                    "Authorization": `Bearer ${session?.access_token || SUPABASE_KEY}`,
                },
                body: JSON.stringify({ expiresIn: expiresInSec }),
            });
            if (!resp.ok) {
                const body = await resp.text();
                console.warn("Storage signed URL 실패:", resp.status, body, "경로:", storagePath);
                return null;
            }
            const data = await resp.json();
            // signedURL 또는 signedUrl 키
            const path = data.signedURL || data.signedUrl;
            if (!path) return null;
            // 절대 URL로 변환
            return `${SUPABASE_URL}/storage/v1${path}`;
        } catch (e) {
            console.error("Storage URL 생성 에러:", e);
            return null;
        }
    },
};


// 전역 노출
window.Session = Session;
window.Auth = Auth;
window.DB = DB;
window.Storage = Storage;
