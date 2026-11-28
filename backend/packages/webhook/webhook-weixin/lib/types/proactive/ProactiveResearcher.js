/**
 * 主动研究：从画像推断里挑一条，先规划搜索词，再联网查，写成记事簿，并把“已调研”写回画像。
 * 状态机：no_candidate / no_need / skipped / temporary_failure / success。
 * 只有 success 消耗当天预算；其余状态都会显式安排下一次检查，绝不把 next_research_at 留在过去。
 */
import { existsSync, readFileSync } from 'node:fs';
import { probe } from '../diagnostics/probe.js';
import { actionable, pick_inference } from '../profile/ProfileInference.js';
/** 本地日期 YYYY-MM-DD。 */
function local_date(now) {
    const date = new Date(now);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
/** 主动研究器。 */
export class ProactiveResearcher {
    constructor(options) {
        this.options = options;
        this.plan_guidance = existsSync(options.plan_prompt_path) ? readFileSync(options.plan_prompt_path, 'utf8') : '输出两行：一行搜索词，一行想回答的问题；不适合查就输出：无';
        this.summary_guidance = existsSync(options.summary_prompt_path) ? readFileSync(options.summary_prompt_path, 'utf8') : '只输出要发给主人的话；没有有用信息就输出：无';
    }
    /** 跑一次主动研究。 */
    async run_due(now, force) {
        const state = this.options.store.state();
        if (state.next_research_at === undefined) {
            this.schedule_check(now, 'cold_start');
            return;
        }
        if (!force && now < state.next_research_at) return;
        const snapshot = await this.options.profile.read();
        const actionable_list = snapshot.inferences.filter((item) => actionable(item));
        const candidate = pick_inference(snapshot.inferences, now, (item) => this.has_fresh_research(item.key, now) || this.options.store.skipped(item.key, now));
        if (candidate === undefined) {
            const fresh = snapshot.inferences.filter((item) => this.has_fresh_research(item.key, now)).length;
            const skipped = snapshot.inferences.filter((item) => this.options.store.skipped(item.key, now)).length;
            const status = actionable_list.length === 0 ? 'no_candidate' : 'no_need';
            probe('inference', status, { total: snapshot.inferences.length, fresh, skipped });
            this.schedule_check(now, status);
            return;
        }
        if (!force && !this.options.store.has_budget(now, this.options.max_per_day ?? 3)) {
            probe('proactive', 'research.budget_exhausted');
            this.schedule_check(now, 'budget');
            return;
        }
        const outcome = await this.research(candidate, snapshot.notes, now);
        if (outcome.status === 'success') {
            if (!force) this.options.store.consume_budget(now);
            this.schedule_next(now);
            return;
        }
        if (outcome.status === 'temporary_failure') {
            this.schedule_check(now, 'retry');
            return;
        }
        this.schedule_check(now, 'skipped');
    }
    /** 查一条推断并落库，返回明确状态。 */
    async research(candidate, notes, now) {
        const plan = await this.plan(candidate, notes);
        if (plan.kind === 'error') {
            probe('inference', 'plan_failed', { key: candidate.key, error: plan.error });
            return { status: 'temporary_failure', reason: 'plan' };
        }
        if (plan.kind === 'skip') {
            probe('inference', 'not_actionable', { key: candidate.key });
            this.options.store.mark_skipped(candidate.key, now + 7 * 86_400_000);
            return { status: 'skipped', reason: 'not_actionable' };
        }
        const web = this.options.web;
        if (web === undefined) {
            probe('inference', 'web_unavailable');
            return { status: 'temporary_failure', reason: 'web' };
        }
        probe('inference', 'research.start', { key: candidate.key, query: plan.query });
        let found;
        try {
            found = await web.search({ query: plan.query, maxResults: 6 }, AbortSignal.timeout(this.options.search_timeout_ms ?? 120_000));
        } catch (error) {
            probe('inference', 'search_failed', { key: candidate.key, error: String(error).slice(0, 160) });
            return { status: 'temporary_failure', reason: 'search' };
        }
        const content = (found.content ?? '').trim();
        const sources = (found.sources ?? []).slice(0, 6);
        if (content === '' && sources.length === 0) {
            probe('inference', 'empty', { key: candidate.key });
            return { status: 'temporary_failure', reason: 'empty' };
        }
        const prompt = [
            this.summary_guidance,
            '',
            `【画像推断】${candidate.text}（${candidate.confidence}，${candidate.evidence_month}）`,
            `【想回答的问题】${plan.question}`,
            '【搜索正文】',
            content === '' ? '（空）' : content.slice(0, 6000),
            '',
            '【来源】',
            sources.map((item) => `- ${item.url}${item.title === undefined ? '' : ' ' + item.title}`).join('\n')
        ].join('\n');
        let text = '';
        try {
            text = (await this.options.complete(prompt, 900)).trim();
        } catch (error) {
            probe('inference', 'model_failed', { key: candidate.key, error: String(error).slice(0, 160) });
            return { status: 'temporary_failure', reason: 'model' };
        }
        if (text === '' || text === '无' || text.startsWith('无') && text.length <= 12) {
            probe('inference', 'no_change', { key: candidate.key });
            this.options.store.mark_skipped(candidate.key, now + 3 * 86_400_000);
            return { status: 'skipped', reason: 'no_change' };
        }
        this.options.notebook.append({
            topic_id: `inference-${candidate.key}`,
            kind: 'inference',
            title: `推断：${candidate.key}`,
            summary: text,
            sources: sources.map((item) => item.url).slice(0, 3),
            fresh_hours: this.fresh_hours_for(candidate),
            created_at: now
        });
        this.options.store.mark_skipped(candidate.key, 0);
        const marked = await this.options.profile.mark_researched(candidate.key, local_date(now));
        await this.options.on_profile_changed?.();
        probe('inference', 'researched', { key: candidate.key, chars: text.length, marked });
        return { status: 'success' };
    }
    /** 先让模型把推断变成一个可搜的问题。 */
    async plan(candidate, notes) {
        const now = Date.now();
        const recent = this.options.notebook.recent(14, now, 8).map((entry) => {
            const fresh = now - entry.created_at < entry.fresh_hours * 3_600_000;
            return `- ${fresh ? '还有效' : '已过期'}｜${entry.title}：${entry.summary.slice(0, 120)}`;
        }).join('\n');
        const prompt = [
            this.plan_guidance,
            '',
            `【画像推断】${candidate.text}（${candidate.confidence}，${candidate.evidence_month}）`,
            '【主人画像】',
            notes.slice(0, 1200),
            '【最近查过】',
            recent === '' ? '（无）' : recent
        ].join('\n');
        let raw = '';
        try {
            raw = (await this.options.complete(prompt, 220)).trim();
        } catch (error) {
            return { kind: 'error', error: String(error).slice(0, 160) };
        }
        if (raw === '' || raw === '无' || raw.startsWith('无') && raw.length <= 6) return { kind: 'skip' };
        const lines = raw.split('\n').map((line) => line.trim()).filter((line) => line !== '');
        const clean = (line) => line.replace(/^(搜索词|搜索|查询|query|问题|想回答的问题)[：:]\s*/i, '').trim();
        const query = clean(lines[0] ?? '').slice(0, 60);
        const question = clean(lines[1] ?? candidate.text).slice(0, 120);
        if (query.length < 2) return { kind: 'error', error: 'empty planning query' };
        return { kind: 'ok', query, question };
    }
    /** 这条推断最近查过、而且结果还在保鲜期内，就不再查。 */
    has_fresh_research(key, now) {
        const latest = this.options.notebook.entries().filter((entry) => entry.topic_id === `inference-${key}`).sort((a, b) => b.created_at - a.created_at)[0];
        if (latest === undefined) return false;
        return now - latest.created_at < latest.fresh_hours * 3_600_000;
    }
    /** 不同推断的保鲜期：价格/出行短，项目/技术长。 */
    fresh_hours_for(candidate) {
        const text = `${candidate.key}${candidate.text}`;
        if (/旅行|机票|价格|显卡|购买|酒店/.test(text)) return 72;
        if (/项目|部署|技术|学习/.test(text)) return 168;
        return 96;
    }
    /** 明确安排下一次检查；不同状态用不同间隔。 */
    schedule_check(now, reason) {
        const hour = 3_600_000;
        let delay = 6 * hour;
        if (reason === 'cold_start') delay = 5 * 60_000;
        else if (reason === 'retry') delay = hour;
        else if (reason === 'budget') delay = this.until_next_day(now);
        const next = now + delay;
        this.options.store.set_state({ next_research_at: next });
        probe('proactive', 'research.scheduled', { next_at: next, reason });
    }
    /** 到本地次日 00:30 的毫秒数。 */
    until_next_day(now) {
        const date = new Date(now);
        const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 30, 0, 0);
        return Math.max(60_000, next.getTime() - now);
    }
    /** 研究成功后的正常间隔：48-72 小时之间随机。 */
    schedule_next(now) {
        const next = this.next_time(now);
        this.options.store.set_state({ next_research_at: next });
        probe('proactive', 'research.scheduled', { next_at: next, reason: 'success' });
    }
    /** 下一次搜索的时间点。 */
    next_time(now) {
        const min = this.options.min_gap_ms ?? 48 * 3_600_000;
        const max = this.options.max_gap_ms ?? 72 * 3_600_000;
        return now + min + Math.floor(Math.random() * Math.max(1, max - min));
    }
}
