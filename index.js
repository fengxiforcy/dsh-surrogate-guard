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

/** Loader 诊断里显示的名字。 */
export const name = 'surrogate-guard';

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

	let out = decision;

	// 1) 决策自身的每个字段：value / content / meta / 工具自定义字段，一律深扫。
	//    2026-10-30 修正：旧版只扫 value 与 content，read 的 data.meta.lines[].text
	//    整段落在扫描范围外，导致 read 截断产生的孤立代理原样写进会话（Kluth 实测）。
	for (const key of Object.keys(out)) {
		if (key === 'kind') continue;
		const current = out[key];
		const scrubbed = scrubValue(current, replacement, stats);
		if (scrubbed !== current) out = { ...out, [key]: scrubbed };
	}

	// 2) 决策没带、但结果上有的载荷字段（read / grep / bash 各自的结构都覆盖）
	if (result && typeof result === 'object') {
		for (const key of ['value', 'content', 'meta', 'data', 'output', 'result', 'lines']) {
			if (Object.hasOwn(out, key)) continue;
			if (!Object.hasOwn(result, key)) continue;
			const current = result[key];
			const scrubbed = scrubValue(current, replacement, stats);
			if (scrubbed !== current) out = { ...out, [key]: scrubbed };
		}
	}

	return out;
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
	};
}

/**
 * 在内容进入会话日志的几个入口上挂中和器。
 * @param ctx 插件上下文
 * @param config 本插件行的配置
 */
export function apply(ctx, config) {
	const options = resolveOptions(config ?? {});

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
		ctx.on('agent/pre-step', async (payload, next) => {
			const decision = await next();
			if (decision.kind !== 'enter') return decision;
			const stats = { count: 0 };
			const messages = scrubValue(decision.messages, options.replacement, stats);
			report(ctx, options.log, stats, 'step messages');
			return messages === decision.messages ? decision : { ...decision, messages };
		});
	}
}
