/**
 * dsh-surrogate-guard —— 把「落单的半个字符」在进入会话日志之前中和掉。
 *
 * 背景（2026-10-29 事故）：DSH 的 read / 工具结果在某些截断路径上会在 emoji 的
 * 代理对中间切断，只留下高位代理 0xD800-0xDBFF（或低位 0xDC00-0xDFFF），
 * 孤零零一个。这种字符在 JS 里合法（JSON.stringify 不报错，转义成 6 个字符），
 * 但送到 DeepSeek API 时 serde_json 解析失败：
 *   serde_json: unexpected end of hex escape
 * 于是整条请求 400 INVALID_REQUEST。因为每轮都重发历史，一旦写进会话，
 * 该会话此后每一轮都 400 —— 重试无效、重启无效，只能手动修文件。
 *
 * 为什么挂在日志入口：dsh-agent-loop 会深冻结请求消息，且规定
 * agent/request 监听器不能改请求；而 Harness 的规则是模型看到的一切
 * 都必须能从会话日志重建。所以改写必须在**写入之前**做，而不是报文出口。
 *
 * 与 dsh-text-guard 的区别：它的靶子是区域指示符对（国旗 emoji，被内容风控拒收），
 * 本插件的靶子是代理对残缺（UTF-16 截断产物），两者症状相同、病灶不同。
 *
 * @module dsh-surrogate-guard
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanSession, fixSession, findSessions } from './lib/vaccine.js';

/** Loader 诊断里显示的名字。 */
export const name = 'surrogate-guard';

/** 修复记录（运行中消费一次，往中毒会话里注入提醒）。 */
const NOTICE_DIR = path.join(process.env.DSH_HOME || 'E:/dsh-home', 'surrogate-guard');
const NOTICE_FILE = path.join(NOTICE_DIR, 'last-repair.json');

/** 写一条「已修复」记录，供下次启动提醒。 */
function writeRepairNotice(info) {
	try {
		fs.mkdirSync(NOTICE_DIR, { recursive: true });
		fs.writeFileSync(NOTICE_FILE, JSON.stringify({ ...info, ts: Date.now() }));
	} catch { /* 不影响修复本身 */ }
}

/** 读取并删除修复记录；超过 24 小时视为过期。 */
function consumeRepairNotice() {
	try {
		if (!fs.existsSync(NOTICE_FILE)) return null;
		const raw = JSON.parse(fs.readFileSync(NOTICE_FILE, 'utf8'));
		fs.unlinkSync(NOTICE_FILE);
		if (!raw || !Number.isFinite(raw.ts) || Date.now() - raw.ts > 24 * 3600 * 1000) return null;
		return raw;
	} catch {
		return null;
	}
}

/** 默认替换符：U+FFFD REPLACEMENT CHARACTER（本身是合法字符，不会二次触发）。 */
const DEFAULT_REPLACEMENT = '\uFFFD';

/**
 * 判断 UTF-16 码元 c 是否需要一个配对。
 * @param c 码元
 * @returns 是否为高位代理
 */
function isHigh(c) {
	return c >= 0xd800 && c <= 0xdbff;
}

/**
 * 判断 UTF-16 码元 c 是否是一个合法的低位代理。
 * @param c 码元
 * @returns 是否为低位代理
 */
function isLow(c) {
	return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * 快速探测：字符串里是否存在落单的代理。命中即返回，代价接近一次线性扫描。
 * @param text 待检查字符串
 * @returns 是否存在孤立代理
 */
export function hasLoneSurrogate(text) {
	if (typeof text !== 'string' || text.length === 0) return false;
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (isHigh(code)) {
			const next = text.charCodeAt(i + 1);
			if (isLow(next)) {
				i += 1;
				continue;
			}
			return true;
		}
		if (isLow(code)) return true;
	}
	return false;
}

/**
 * 把落单的代理替换成替换符；合法代理对原样保留。
 * @param text 待改写字符串
 * @param replacement 替换文本
 * @returns 未命中时返回原字符串（保持引用相等）
 */
export function scrubLoneSurrogates(text, replacement = DEFAULT_REPLACEMENT) {
	if (!hasLoneSurrogate(text)) return text;
	let out = '';
	for (let i = 0; i < text.length; i += 1) {
		const code = text.charCodeAt(i);
		if (isHigh(code)) {
			const next = text.charCodeAt(i + 1);
			if (isLow(next)) {
				out += text[i] + text[i + 1];
				i += 1;
				continue;
			}
			out += replacement;
			continue;
		}
		if (isLow(code)) {
			out += replacement;
			continue;
		}
		out += text[i];
	}
	return out;
}

/**
 * 递归改写 JSON 形态的值，不修改入参；无命中时返回原引用。
 * @param value 待检查值
 * @param replacement 替换文本
 * @param stats 计数
 * @returns 改写后的值（或原引用）
 */
function scrubValue(value, replacement, stats) {
	if (typeof value === 'string') {
		const next = scrubLoneSurrogates(value, replacement);
		if (next !== value) stats.count += 1;
		return next;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((entry) => {
			const scrubbed = scrubValue(entry, replacement, stats);
			if (scrubbed !== entry) changed = true;
			return scrubbed;
		});
		return changed ? next : value;
	}
	if (value === null || typeof value !== 'object') return value;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return value;
	let changed = false;
	const next = {};
	for (const [key, entry] of Object.entries(value)) {
		const scrubbed = scrubValue(entry, replacement, stats);
		if (scrubbed !== entry) changed = true;
		next[key] = scrubbed;
	}
	return changed ? next : value;
}

/**
 * 改写一条被接受的工具决策，保留它已有的每个字段。
 * @param decision 下游链返回的决策
 * @param result 该决策接受的派发结果
 * @param replacement 替换文本
 * @param stats 计数
 * @returns 无命中时返回原决策
 */
export function neutralizeDecision(decision, result, replacement, stats) {
	if (!decision || decision.kind !== 'accept') return decision;
	if (result && result.isError) return decision;

	// 合约：accept 决策**不能同时**替换 value 与 content（DSH tools/post-execute）。
	// 2026-10-30 回归修正（Kluth 实测）：0.1.1 遍历所有字段，read 的 value 与 content
	// 同源同义、两处同时命中，被框架拒掉整条结果（"cannot replace both value and content"）。
	// 所以这里按优先级找**第一处**命中，命中即返回，绝不两处都改。
	// 2026-11-05（0.1.6）：补 stdout/stderr——run_code 的打印可能落在这两个字段上
	// （yingcai233 在 #11476 提醒 run_code 也会触发；这里按字段名兜底，命中才改）。
	const order = ['value', 'content', 'meta', 'data', 'output', 'result', 'lines', 'stdout', 'stderr'];

	for (const key of order) {
		if (!Object.hasOwn(decision, key)) continue;
		const current = decision[key];
		const scrubbed = scrubValue(current, replacement, stats);
		if (scrubbed !== current) return { ...decision, [key]: scrubbed };
	}

	// 决策没带、结果上有的载荷字段（read 的 data.meta.lines[].text 走这里）
	if (result && typeof result === 'object') {
		for (const key of order) {
			if (Object.hasOwn(decision, key)) continue;
			if (!Object.hasOwn(result, key)) continue;
			const current = result[key];
			const scrubbed = scrubValue(current, replacement, stats);
			if (scrubbed !== current) return { ...decision, [key]: scrubbed };
		}
	}

	return decision;
}

/**
 * 打一行摘要日志：只报数量，绝不打印命中的内容。
 * @param ctx 插件上下文
 * @param enabled 是否开启日志
 * @param stats 计数
 * @param where 位置描述
 */
function report(ctx, enabled, stats, where) {
	if (!enabled || stats.count === 0) return;
	ctx.logger.info('surrogate-guard: neutralized ' + stats.count + ' string(s) in ' + where);
}

/**
 * 解析本插件行的配置。
 * @param config 插件配置
 * @returns 统一后的配置
 */
function resolveOptions(config) {
	const replacement = typeof config.replacement === 'string' && config.replacement.length > 0
		? config.replacement
		: DEFAULT_REPLACEMENT;
	return {
		replacement,
		toolResults: config.toolResults !== false,
		userMessages: config.userMessages !== false,
		log: config.log !== false,
		// 2026-11-03 小汐事故后新增：存量会话体检/自修（B 档：自动修，不自动重启）
		autoRepair: config.autoRepair !== false,
		sessionsRoot: typeof config.sessionsRoot === 'string' && config.sessionsRoot.length > 0
			? config.sessionsRoot
			: path.join(process.env.DSH_HOME || 'E:/dsh-home', 'sessions'),
		repairIntervalMs: Number.isFinite(config.repairIntervalMs) ? Math.max(60_000, config.repairIntervalMs) : 1_800_000,
		maxScanFiles: Number.isFinite(config.maxScanFiles) ? Math.max(1, Math.min(50, config.maxScanFiles)) : 3,
		maxFileBytes: Number.isFinite(config.maxFileBytes) ? Math.max(1_048_576, config.maxFileBytes) : 31_457_280,
		// 2026-11-05（0.1.6）：fs.watch 实时监视开关与去抖窗口
		realtime: config.realtime !== false,
		watchDebounceMs: Number.isFinite(config.watchDebounceMs) ? Math.max(200, config.watchDebounceMs) : 1000,
	};
}

/**
 * 在内容进入会话日志的几个入口上挂中和器。
 * @param ctx 插件上下文
 * @param config 本插件行的配置
 */
export function apply(ctx, config) {
	const options = resolveOptions(config ?? {});

	// 0.1.9：缓存最近一次 pre-step 的 agent，修复时优先把提醒推给「用户正在看的会话」。
	let lastAgent = null;
	// 0.1.10：最近一次修复记录，供客户端弹窗轮询（/surrogate-guard/pending）。
	let lastRepair = null;

	// 修复提醒：由 pre-step 在运行时往会话里注入一条可见消息（只一次）。

	if (options.toolResults) {
		ctx.on('tools/post-execute', async (exec, result, next) => {
			const decision = await next();
			if (decision.kind !== 'accept') return decision;
			const stats = { count: 0 };
			const scrubbed = neutralizeDecision(decision, result, options.replacement, stats);
			report(ctx, options.log, stats, exec.name + ' result');
			return scrubbed;
		});
		ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
			const content = await next();
			const stats = { count: 0 };
			const scrubbed = scrubValue(content, options.replacement, stats);
			report(ctx, options.log, stats, dispatch.name + ' dispatch');
			return scrubbed;
		});
	}

	if (options.userMessages) {
		let lastNoticeCheck = 0;
		ctx.on('agent/pre-step', async (payload, next) => {
			const decision = await next();

			// 修复提醒：往当前会话注入一条可见消息，让用户当场看到「请重启」。
			// 只注入一次（消费标记），60 秒节流，失败不影响正常流程。
			try {
				if (payload?.agent) lastAgent = payload.agent;
				if (payload?.agent && Date.now() - lastNoticeCheck > 60_000) {
					lastNoticeCheck = Date.now();
					const notice = consumeRepairNotice();
					if (notice && !notice.notified) {
						payload.agent.inject({
							id: randomUUID(),
							role: 'user',
							content: [{
								type: 'text',
								text: '[surrogate-guard] 检测到会话 ' + (notice.session || '未知') +
									' 的日志含半个 emoji（孤立代理），已自动修复并备份（' +
									(notice.backup || '无备份') + '）。请点击「热重启」按钮（或重启 DSH）后继续使用该会话。',
							}],
							source: { kind: 'surrogate-guard' },
						});
						ctx.logger.warn('surrogate-guard: repair notice injected into ' + (notice.session || 'session'));
					}
				}
			} catch (e) {
				ctx.logger.warn('surrogate-guard: notice inject failed: ' + (e?.message || e));
			}

			if (decision.kind !== 'enter') return decision;
			const stats = { count: 0 };
			const messages = scrubValue(decision.messages, options.replacement, stats);
			report(ctx, options.log, stats, 'step messages');
			return messages === decision.messages ? decision : { ...decision, messages };
		});
	}

	// ── 存量会话自检自修（2026-11-03 小汐事故后加）────────────────────────────
	// 钩子只覆盖「进入之前」；毒一旦落盘（agent/inbox/spliced）钩子就看不到。
	// 这里在模型请求失败时 + 定时，扫描最近修改的会话文件，命中就备份并修复。
	// 注意：修的是磁盘文件；当前进程内存里的会话仍是坏的，必须重启 DSH 才生效。
	const repairing = new Set();
	let lastRun = 0;

	/** 最近修改的会话文件（findSessions 会递归，按 mtime 取前 N 个）。 */
	const recentSessions = () => {
		const all = findSessions(options.sessionsRoot);
		const rows = [];
		for (const file of all) {
			try {
				const st = fs.statSync(file);
				if (st.size > options.maxFileBytes) continue;
				rows.push({ file, mtime: st.mtimeMs });
			} catch { /* ignore */ }
		}
		rows.sort((a, b) => b.mtime - a.mtime);
		return rows.slice(0, options.maxScanFiles).map((r) => r.file);
	};

	/**
	 * 修复成功即刻往所有活跃会话推一条提醒（0.1.8）。
	 * 背景：pre-step 注入要等用户下一句话，用户不发消息就永远不知道「已修好、该重启」。
	 * 这里用 ctx.get('agents').list() + agent.inject() 主动推；失败时 pre-step 仍会兜底。
	 * 注意：agents 服务要通过 ctx.get('agents') 取（0.1.8 首次写成 ctx.agents 拿到空）。
	 */
	const notifyAgents = (info) => {
		const text = '[surrogate-guard] 检测到会话 ' + (info.session || '未知') +
			' 的日志含半个 emoji（孤立代理），已自动修复并备份（' + (info.backup || '无备份') +
			'）。请点击「热重启」按钮（或重启 DSH）后继续使用该会话。';
		let count = 0;
		try {
			// 0.1.9：首选「用户最近在看的会话」（pre-step 缓存），再补其它活跃会话。
			const service = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
			const listed = service && typeof service.list === 'function' ? service.list() : [];
			const targets = [];
			if (lastAgent) targets.push(lastAgent);
			for (const agent of listed) {
				if (agent !== lastAgent) targets.push(agent);
			}
			ctx.logger?.warn?.('surrogate-guard: notifyAgents targets=' + targets.length +
				' (lastAgent=' + (lastAgent ? 'yes' : 'no') + ', listed=' + (Array.isArray(listed) ? listed.length : 'n/a') + ')');
			for (const agent of targets) {
				try {
					agent.inject({
						id: randomUUID(),
						role: 'user',
						content: [{ type: 'text', text }],
						source: { kind: 'surrogate-guard' },
					});
					count += 1;
				} catch { /* 单个会话失败不影响其它 */ }
			}
		} catch (e) {
			ctx.logger?.warn?.('surrogate-guard: notify agents failed: ' + (e?.message || e));
		}
		return count;
	};

	/** 扫描并修复一批会话；同一文件不会并发处理。 */
	const repairSessions = (files) => {
		for (const file of files) {
			if (repairing.has(file)) continue;
			repairing.add(file);
			setImmediate(() => {
				try {
					const before = scanSession(file);
					if (!before.hits.length) return;
					const fixed = fixSession(file, { backup: true });
					const sessionName = path.relative(options.sessionsRoot, path.dirname(file)).split(path.sep).join('/');
					const backupName = fixed.backup ? path.basename(fixed.backup) : null;
					// 0.1.10：记录最近一次修复，供客户端弹窗轮询
					lastRepair = { session: sessionName, backup: backupName, ts: Date.now() };
					// 0.1.8：修复成功即主动推给所有活跃会话，不再等下一轮 pre-step
					const notifyCount = notifyAgents({ session: sessionName, backup: backupName });
					writeRepairNotice({ session: sessionName, fixed: fixed.fixed, backup: backupName, file, notified: notifyCount > 0 });
					ctx.logger.warn(
						'surrogate-guard: repaired ' + fixed.fixed + ' lone surrogate(s) in ' + sessionName +
						' (backup: ' + (backupName || 'none') + '). RESTART DSH to reload the session.',
					);
				} catch (e) {
					ctx.logger.warn('surrogate-guard: repair failed for ' + file + ': ' + (e?.message || e));
				} finally {
					repairing.delete(file);
				}
			});
		}
	};

	// 客户端弹窗通道（0.1.10）：浏览器端轮询这个路由，拿到最近一次修复记录就弹系统通知，
	// 不依赖用户是否正好在看某个对话。webServer 不可用时静默跳过，不影响修复本身。
	try {
		if (typeof ctx.inject === 'function') {
			ctx.inject(['webServer'], (child) => {
				child.effect(() => child.webServer.register({
					kind: 'exact',
					path: '/surrogate-guard/pending',
					handler: async (req, res) => {
						if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
						res.setHeader('content-type', 'application/json; charset=utf-8');
						res.end(JSON.stringify(lastRepair || {}));
					},
				}));
			});
		}
	} catch (e) {
		ctx.logger?.warn?.('surrogate-guard: pending route unavailable: ' + (e?.message || e));
	}

	if (options.autoRepair) {
		// 1) 模型请求失败（尤其 400 INVALID_REQUEST）时，扫最近会话
		ctx.on('agent/request-error', async (payload, next) => {
			const decision = await next();
			// 不返回 retry：毒在内存里仍存在，重试只会再失败；修文件后由人重启。
			try {
				// 任何请求失败都扫一次（不匹配错误关键词，避免 400 文案变化导致漏检）；
				// 扫描只读、几十毫秒，扫不到就不动作。
				const now = Date.now();
				if (now - lastRun > 30_000) {
					lastRun = now;
					repairSessions(recentSessions());
				}
			} catch (e) {
				ctx.logger.warn('surrogate-guard: request-error handler failed: ' + (e?.message || e));
			}
			return decision;
		});

		// 2) 定时巡检（默认 30 分钟），兜底没触发 request-error 的毒
		const timer = setInterval(() => {
			try { repairSessions(recentSessions()); } catch (e) {
				ctx.logger.warn('surrogate-guard: periodic scan failed: ' + (e?.message || e));
			}
		}, options.repairIntervalMs);

		// 3) 实时监视（2026-11-05 · 0.1.6 新增）：会话文件一变就扫，把暴露窗口从
		//    「最多 30 分钟」压到「1 秒左右」。背景：0.1.5 只有请求失败兜底 + 定时巡检，
		//    两次巡检之间中毒会连炸好几轮 400。这里只处理 .jsonl.zstd、按文件去抖，
		//    文件大小没变就跳过；fs.watch 不可用时静默降级为原定时巡检。
		let watcher = null;
		const pending = new Map();
		const lastSize = new Map();
		const scheduleScan = (file) => {
			if (repairing.has(file) || pending.has(file)) return;
			const t = setTimeout(() => {
				pending.delete(file);
				try {
					const st = fs.statSync(file);
					if (st.size > options.maxFileBytes) return;
					if (lastSize.get(file) === st.size) return;
					lastSize.set(file, st.size);
					repairSessions([file]);
				} catch { /* 文件可能已被重写或删除，忽略 */ }
			}, options.watchDebounceMs);
			pending.set(file, t);
		};
		if (options.realtime) {
			try {
				watcher = fs.watch(options.sessionsRoot, { recursive: true }, (eventType, name) => {
					if (!name) return;
					const rel = String(name);
					if (!rel.endsWith('.jsonl.zstd')) return;
					scheduleScan(path.join(options.sessionsRoot, rel));
				});
				watcher.on?.('error', (e) => {
					ctx.logger.warn('surrogate-guard: watcher error, fallback to periodic scan: ' + (e?.message || e));
				});
			} catch (e) {
				ctx.logger.warn('surrogate-guard: fs.watch unavailable, fallback to periodic scan: ' + (e?.message || e));
			}
		}

		return () => {
			clearInterval(timer);
			for (const t of pending.values()) clearTimeout(t);
			pending.clear();
			try { watcher?.close(); } catch { /* ignore */ }
		};
	}
}
