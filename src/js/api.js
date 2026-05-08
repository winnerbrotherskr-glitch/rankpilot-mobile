// ============================================================
// 비즈니스 로직 — PC앱의 db_supabase.py와 동일 시그니처
// ============================================================
//
// 핵심 정책 (PC앱과 100% 동일):
//   add_keyword:
//     - monthly: 같은 키워드 있으면 URL/capture만 업데이트
//     - oneshot: 같은 키워드 + 같은 URL이면 거부, URL 다르면 새 행
//   delete: PostgreSQL CASCADE가 자동 정리
//   add_*: 프로필 한도/만료 체크 (Phase 2)
// ============================================================

const API = {

    // ========== 사용자 프로필 (Phase 2) ==========

    async getUserProfile() {
        const res = await DB.select("user_profiles", {
            filters: { user_id: `eq.${Session.user()?.id}` },
            single: true,
        });
        if (!res.ok || !res.data) {
            // 디폴트 (트리거 못 돈 케이스 방어)
            return {
                plan_name: "trial",
                max_keywords: 20,
                max_groups: 2,
                expires_at: null,
                is_active: true,
                is_admin: false,
            };
        }
        return res.data;
    },

    /** 계정 상태 검사. 문제 있으면 에러 메시지, 정상이면 null. */
    _checkAccountStatus(profile) {
        if (!profile.is_active) {
            return "계정이 비활성화되었어요. 관리자에게 문의해주세요.";
        }
        if (profile.expires_at) {
            const exp = new Date(profile.expires_at);
            const now = new Date();
            if (now > exp) {
                const dateStr = exp.toISOString().slice(0, 10);
                return `구독이 ${dateStr}에 만료되었어요. 관리자에게 문의해주세요.`;
            }
        }
        return null;
    },

    async _totalKeywordCount() {
        const res = await DB.select("keywords", { columns: "id" });
        return res.ok ? res.data.length : 0;
    },

    async _totalGroupCount() {
        const res = await DB.select("groups", { columns: "id" });
        return res.ok ? res.data.length : 0;
    },


    // ========== 그룹 ==========

    async listGroups() {
        const res = await DB.select("groups", { order: "id.asc" });
        if (!res.ok) return [];
        return res.data.map(r => ({
            ...r,
            schedule_times_list: this._parseScheduleTimes(r.schedule_times),
        }));
    },

    async getGroup(groupId) {
        const res = await DB.select("groups", {
            filters: { id: `eq.${groupId}` },
            single: true,
        });
        if (!res.ok || !res.data) return null;
        return {
            ...res.data,
            schedule_times_list: this._parseScheduleTimes(res.data.schedule_times),
        };
    },

    _parseScheduleTimes(json) {
        try { return JSON.parse(json || "[]"); }
        catch { return []; }
    },

    /** 그룹 생성 (모바일 — 단순) */
    async addGroup({ name, mode, slot_limit, schedule_times, retry_minutes, verify_hours }) {
        const profile = await this.getUserProfile();
        const err = this._checkAccountStatus(profile);
        if (err) return { ok: false, error: err };

        // 그룹 한도 체크
        if (profile.max_groups !== -1) {
            const cur = await this._totalGroupCount();
            if (cur >= profile.max_groups) {
                return {
                    ok: false,
                    error: `그룹 한도 초과 (${cur}/${profile.max_groups}). PC앱에서 플랜 업그레이드를 문의해주세요.`,
                };
            }
        }

        const userId = Session.user()?.id;
        if (!userId) return { ok: false, error: "로그인 세션이 없어요" };

        // schedule_times를 JSON 형태로
        let scheduleTimesJson = "[]";
        if (schedule_times) {
            // 단일 시간 문자열이면 배열로
            const arr = Array.isArray(schedule_times)
                ? schedule_times
                : [schedule_times].filter(Boolean);
            scheduleTimesJson = JSON.stringify(arr);
        }

        const res = await DB.insert("groups", {
            user_id: userId,
            name,
            mode,
            slot_limit: parseInt(slot_limit, 10) || 10,
            schedule_times: scheduleTimesJson,
            retry_interval_min: parseInt(retry_minutes, 10) || 15,
            verify_after_hours: parseInt(verify_hours, 10) || 24,
        });

        if (!res.ok) {
            return { ok: false, error: res.error || "생성 실패" };
        }
        return { ok: true, group: res.data };
    },

    /** 그룹 편집 — name, slot_limit만 (모드는 변경 불가) */
    async updateGroup(groupId, { name, slot_limit }) {
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (slot_limit !== undefined) patch.slot_limit = parseInt(slot_limit, 10);

        const res = await DB.update("groups", patch, { id: `eq.${groupId}` });
        if (!res.ok) {
            return { ok: false, error: res.error || "저장 실패" };
        }
        return { ok: true };
    },

    /** 그룹 삭제 — CASCADE로 키워드/결과까지 자동 삭제 */
    async deleteGroup(groupId) {
        const res = await DB.delete("groups", { id: `eq.${groupId}` });
        if (!res.ok) {
            return { ok: false, error: res.error || "삭제 실패" };
        }
        return { ok: true };
    },


    // ========== 키워드 ==========

    async listKeywords() {
        const res = await DB.select("keywords", {
            order: "sort_order.asc,id.asc",
        });
        if (!res.ok) return [];

        const groups = await this.listGroups();
        const gMap = new Map(groups.map(g => [g.id, g]));

        return res.data.map(k => ({
            ...k,
            group_name: gMap.get(k.group_id)?.name,
            group_mode: gMap.get(k.group_id)?.mode,
        }));
    },

    async keywordsInGroup(groupId) {
        const res = await DB.select("keywords", {
            filters: { group_id: `eq.${groupId}` },
            order: "sort_order.asc,id.asc",
        });
        return res.ok ? res.data : [];
    },

    async groupKeywordCount(groupId) {
        const res = await DB.select("keywords", {
            columns: "id",
            filters: { group_id: `eq.${groupId}` },
        });
        return res.ok ? res.data.length : 0;
    },

    /** 키워드 추가 — 월보장/건바이 모드별 분기 (PC앱 정책 동일) */
    async addKeyword({ keyword, target_url, capture, group_id }) {
        keyword = (keyword || "").trim();
        target_url = (target_url || "").trim();

        if (!keyword || !target_url) {
            return { ok: false, error: "키워드와 URL은 비울 수 없어요" };
        }
        if (!group_id) {
            return { ok: false, error: "그룹을 선택해주세요" };
        }

        const user = Session.user();
        if (!user) return { ok: false, error: "로그인이 필요해요" };

        const g = await this.getGroup(group_id);
        if (!g) return { ok: false, error: "그룹을 찾을 수 없어요" };

        const captureInt = capture ? 1 : 0;

        // ===== 모드별 중복 처리 =====
        if (g.mode === "monthly") {
            const dup = await this._findKeywordInGroup(group_id, keyword);
            if (dup) {
                if (dup.target_url === target_url && dup.capture === captureInt) {
                    return { ok: true, id: dup.id, action: "unchanged" };
                }
                const upd = await DB.update("keywords",
                    { target_url, capture: captureInt },
                    { id: `eq.${dup.id}` }
                );
                if (!upd.ok) return { ok: false, error: upd.error };
                return { ok: true, id: dup.id, action: "updated" };
            }
        } else {
            // oneshot — 키워드 + URL 둘 다 같아야 진짜 중복
            const dup = await this._findKeywordInGroup(group_id, keyword, target_url);
            if (dup) {
                return {
                    ok: false,
                    error: "이 그룹에 같은 키워드+같은 URL이 이미 있어요",
                    existing_id: dup.id,
                };
            }
        }

        // ===== 슬롯 한도 검사 =====
        const cnt = await this.groupKeywordCount(group_id);
        if (cnt >= g.slot_limit) {
            return { ok: false, error: `'${g.name}' 그룹의 슬롯 한도(${g.slot_limit}) 초과` };
        }

        // ===== INSERT =====
        const nextSort = await this._nextSortOrder(group_id);
        const row = {
            user_id: user.id,
            group_id,
            keyword,
            target_url,
            capture: captureInt,
            sort_order: nextSort,
        };
        const ins = await DB.insert("keywords", row);
        if (!ins.ok) return { ok: false, error: ins.error };
        const newId = ins.data[0].id;

        // 건바이 → oneshot_job 자동 생성 (즉시 발화)
        if (g.mode === "oneshot") {
            try {
                await this._createOneshotJob(newId);
            } catch (e) {
                console.warn("oneshot_job 생성 실패 (키워드는 추가됨):", e);
            }
        }

        return { ok: true, id: newId, action: "added" };
    },

    /** 키워드 편집 — target_url, capture만 (키워드명은 변경 불가) */
    async updateKeyword(keywordId, { target_url, capture }) {
        const patch = {};
        if (target_url !== undefined) patch.target_url = target_url;
        if (capture !== undefined) patch.capture = !!capture;

        if (Object.keys(patch).length === 0) {
            return { ok: false, error: "변경할 내용이 없어요" };
        }

        const res = await DB.update("keywords", patch, { id: `eq.${keywordId}` });
        if (!res.ok) {
            return { ok: false, error: res.error || "저장 실패" };
        }
        return { ok: true };
    },

    /** 키워드 삭제 — CASCADE로 결과/캡처도 같이 삭제됨 */
    async deleteKeyword(keywordId) {
        const res = await DB.delete("keywords", { id: `eq.${keywordId}` });
        if (!res.ok) {
            return { ok: false, error: res.error || "삭제 실패" };
        }
        return { ok: true };
    },

    async _findKeywordInGroup(groupId, keyword, targetUrl = null) {
        const filters = {
            group_id: `eq.${groupId}`,
            keyword: `eq.${keyword}`,
        };
        if (targetUrl !== null) {
            filters.target_url = `eq.${targetUrl}`;
        }
        const res = await DB.select("keywords", { filters, limit: 1 });
        if (!res.ok || res.data.length === 0) return null;
        return res.data[0];
    },

    async _nextSortOrder(groupId) {
        const res = await DB.select("keywords", {
            columns: "sort_order",
            filters: { group_id: `eq.${groupId}` },
            order: "sort_order.desc",
            limit: 1,
        });
        if (!res.ok || res.data.length === 0) return 1;
        return (Number(res.data[0].sort_order) || 0) + 1;
    },

    async _createOneshotJob(keywordId) {
        const user = Session.user();
        if (!user) return;
        const nowStr = this._toLocalSqlTime(new Date());
        const row = {
            user_id: user.id,
            keyword_id: keywordId,
            state: "retrying",
            next_action_at: nowStr,
        };
        const res = await DB.insert("oneshot_jobs", row, { return: false });
        // 이미 있으면 23505 — 정상, 무시
        if (!res.ok && res.error && !res.error.includes("이미")) {
            console.warn("oneshot_job 생성 실패:", res.error);
        }
    },

    /** SQL 호환 'YYYY-MM-DD HH:MM:SS' 형식 (로컬 시각). */
    _toLocalSqlTime(d) {
        const pad = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
               ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },


    // ========== 검사 결과 (각 키워드 최신 1건) ==========

    /** 모든 키워드 + 각자의 최근 결과 머지 (대시보드용) */
    async listKeywordsWithLatestResult() {
        const keywords = await this.listKeywords();
        if (keywords.length === 0) return [];

        // 모든 키워드의 최근 결과 한 번에 조회 후 클라이언트에서 매핑
        const kwIds = keywords.map(k => k.id);
        const inFilter = `in.(${kwIds.join(",")})`;
        const res = await DB.select("results", {
            filters: { keyword_id: inFilter },
            order: "id.desc",
            limit: 5000,  // 충분히 크게
        });
        const results = res.ok ? res.data : [];

        const latestMap = new Map();
        for (const r of results) {
            if (!latestMap.has(r.keyword_id)) {
                latestMap.set(r.keyword_id, r);
            }
        }

        // 건바이 잡 정보도 머지
        const oneshotRes = await DB.select("oneshot_jobs", {
            filters: { keyword_id: inFilter },
        });
        const oneshotMap = new Map();
        if (oneshotRes.ok) {
            for (const o of oneshotRes.data) {
                oneshotMap.set(o.keyword_id, o);
            }
        }

        return keywords.map(k => {
            const last = latestMap.get(k.id);
            const oj = oneshotMap.get(k.id);
            return {
                ...k,
                last_rank: last?.rank ?? null,
                last_section: last?.section ?? null,
                last_check_at: last?.timestamp ?? null,
                last_blocked: last?.blocked ?? 0,
                last_error: last?.error ?? null,
                oneshot_state: oj?.state ?? null,
                oneshot_first_exposed_at: oj?.first_exposed_at ?? null,
                oneshot_first_rank: oj?.first_rank ?? null,
            };
        });
    },


    // ========== 7일 매트릭스 ==========

    /** 검사 결과 목록 — 최근 N개 (그룹/키워드 필터 가능) */
    async listRecentResults({ groupId = null, keywordId = null, limit = 50 } = {}) {
        let kwIds = null;

        if (keywordId) {
            kwIds = [keywordId];
        } else if (groupId) {
            // 그 그룹의 모든 키워드 ID
            const kwRes = await DB.select("keywords", {
                columns: "id",
                filters: { group_id: `eq.${groupId}` },
            });
            if (!kwRes.ok || kwRes.data.length === 0) return [];
            kwIds = kwRes.data.map(k => k.id);
        }

        // results 조회
        const filters = {};
        if (kwIds && kwIds.length > 0) {
            filters.keyword_id = `in.(${kwIds.join(",")})`;
        }

        const res = await DB.select("results", {
            filters,
            order: "id.desc",
            limit: Math.min(limit, 200),  // 안전장치
        });

        if (!res.ok) return [];

        // 키워드 정보 머지 (그룹명/모드)
        const groups = await this.listGroups();
        const gMap = new Map(groups.map(g => [g.id, g]));

        const allKws = await this.listKeywords();
        const kMap = new Map(allKws.map(k => [k.id, k]));

        return res.data.map(r => {
            const kw = kMap.get(r.keyword_id);
            const grp = kw ? gMap.get(kw.group_id) : null;
            return {
                ...r,
                group_id: kw?.group_id,
                group_name: grp?.name,
                group_mode: grp?.mode,
                kw_capture_enabled: kw?.capture ?? 0,
            };
        });
    },


    /** 키워드의 검사 이력 (시간순) — 추이 그래프용 */
    async resultHistoryForKeyword(keywordId, limit = 30) {
        const res = await DB.select("results", {
            filters: { keyword_id: `eq.${keywordId}` },
            order: "timestamp.desc",
            limit,
        });
        if (!res.ok) return [];
        // 시간 오름차순 (그래프에 그리려면)
        return res.data.reverse();
    },


    // ========== 7일 매트릭스 ==========

    /** 키워드 ID 배열에 대해 최근 7일 매트릭스 데이터 */
    async sevenDayMatrix(keywordIds) {
        if (!keywordIds || keywordIds.length === 0) return {};

        const today = new Date();
        const start = new Date(today);
        start.setDate(start.getDate() - 6);
        const startDate = start.toISOString().slice(0, 10);
        const endDate = today.toISOString().slice(0, 10);

        const inFilter = `in.(${keywordIds.join(",")})`;
        const resultsRes = await DB.select("results", {
            filters: { keyword_id: inFilter },
            order: "id.asc",
            limit: 50000,
        });
        const results = resultsRes.ok ? resultsRes.data : [];

        // runs 정보 (날짜 기준은 run.started_at)
        const runIds = [...new Set(results.map(r => r.run_id).filter(Boolean))];
        const runsMap = new Map();
        if (runIds.length > 0) {
            const runsRes = await DB.select("runs", {
                columns: "id,started_at,trigger",
                filters: { id: `in.(${runIds.join(",")})` },
            });
            if (runsRes.ok) {
                for (const r of runsRes.data) runsMap.set(r.id, r);
            }
        }

        // 키워드별 일자별 집계
        const out = {};
        for (const kid of keywordIds) out[kid] = {};

        for (const r of results) {
            const run = runsMap.get(r.run_id);
            if (!run) continue;
            const d = (run.started_at || "").slice(0, 10);
            if (!d || d < startDate || d > endDate) continue;

            const exposed = (r.rank !== null && !r.blocked && !(r.error || "").trim());
            const slot = out[r.keyword_id][d] || { met: false, best_rank: null, count: 0 };
            slot.count += 1;
            if (exposed) {
                slot.met = true;
                if (slot.best_rank === null || r.rank < slot.best_rank) {
                    slot.best_rank = r.rank;
                }
            }
            out[r.keyword_id][d] = slot;
        }

        return out;
    },

    // 7일 날짜 배열 (최근 7일, 오늘 포함)
    last7Days() {
        const out = [];
        const today = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            out.push(d.toISOString().slice(0, 10));
        }
        return out;
    },
};

window.API = API;
