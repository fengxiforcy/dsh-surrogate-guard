/**
 * 离线单测：不依赖 DSH 运行时。
 * 注意：本文件里不写真实孤立代理，一律用 String.fromCharCode 构造。
 */
import assert from 'node:assert/strict';
import { hasLoneSurrogate, scrubLoneSurrogates, neutralizeDecision } from '../index.js';

const HI = String.fromCharCode(0xd83d);          // lone high
const LO = String.fromCharCode(0xde00);          // lone low
const PAIR = String.fromCharCode(0xd83d, 0xde00); // valid pair

// 1. 干净文本：不命中，且返回同一引用
const clean = '正常的中文 with ascii and emoji \u{1F600}';
assert.equal(hasLoneSurrogate(clean), false);
assert.equal(scrubLoneSurrogates(clean), clean);
assert.ok(Object.is(scrubLoneSurrogates(clean), clean), '干净文本必须返回同一引用');

// 2. 孤立高位代理
assert.equal(hasLoneSurrogate('前' + HI), true);
assert.equal(scrubLoneSurrogates('前' + HI), '前\uFFFD');

// 3. 孤立低位代理
assert.equal(hasLoneSurrogate(LO + '后'), true);
assert.equal(scrubLoneSurrogates(LO + '后'), '\uFFFD后');

// 4. 合法代理对原样保留
assert.equal(hasLoneSurrogate(PAIR), false);
assert.equal(scrubLoneSurrogates(PAIR), PAIR);

// 5. 合法对中间夹一个落单高位
const mixed = 'a' + HI + 'b' + PAIR + 'c';
assert.equal(hasLoneSurrogate(mixed), true);
assert.equal(scrubLoneSurrogates(mixed), 'a\uFFFDb' + PAIR + 'c');

// 6. 自定义替换文本
assert.equal(scrubLoneSurrogates(HI, '[?]'), '[?]');

// 7. 连续两个高位代理
assert.equal(scrubLoneSurrogates(HI + HI), '\uFFFD\uFFFD');

// 8. 空字符串与非法入参
assert.equal(hasLoneSurrogate(''), false);
assert.equal(hasLoneSurrogate(null), false);
assert.equal(scrubLoneSurrogates(''), '');

// 9. 幂等：擦过一次再擦不变化
const once = scrubLoneSurrogates('x' + HI + 'y');
assert.equal(scrubLoneSurrogates(once), once);

// 10. read 工具真实结构：孤立代理在 meta.lines[].text（2026-10-30 Kluth 实测缺口）
const readDecision = {
  kind: 'accept',
  content: '1: aaaa...a... (line truncated to 2000 chars)',
  meta: { path: 'probe.txt', offset: 1, totalLines: 1, lines: [{ number: 1, text: 'a'.repeat(20) + HI }] },
};
const readResult = { isError: false, meta: readDecision.meta };
const outRead = neutralizeDecision(readDecision, readResult, '\uFFFD', { count: 0 });
assert.equal(hasLoneSurrogate(outRead.meta.lines[0].text), false, 'meta 里的孤立代理必须被清掉');
assert.ok(outRead.meta.lines[0].text.endsWith('\uFFFD'));
assert.equal(hasLoneSurrogate(outRead.content), false);
assert.ok(Object.is(neutralizeDecision({ kind: 'accept', value: 'clean' }, { isError: false }, '\uFFFD', { count: 0 }).value, 'clean'));

// 11. 孤立代理只在 result 上、decision 没带 → 也要清掉
const resultOnly = { isError: false, meta: { lines: [{ number: 1, text: HI + 'x' }] } };
const outR = neutralizeDecision({ kind: 'accept', content: 'ok' }, resultOnly, '\uFFFD', { count: 0 });
assert.ok(outR.meta, 'result 的 meta 必须被带回决策');
assert.equal(hasLoneSurrogate(outR.meta.lines[0].text), false);

// 12. 错误结果不改（保持一致）
const errDecision = { kind: 'accept', content: 'x' + HI };
const outErr = neutralizeDecision(errDecision, { isError: true }, '\uFFFD', { count: 0 });
assert.equal(outErr, errDecision, 'isError 时不得改写');

// 13. 拒绝决策不改
const reject = { kind: 'reject' };
assert.equal(neutralizeDecision(reject, {}, '\uFFFD', { count: 0 }), reject);

// 14. 合约：accept 决策不能同时替换 value 与 content（0.1.1 回归，Kluth 实测）
const both = { kind: 'accept', value: { text: 'x' + HI }, content: 'y' + HI };
const outBoth = neutralizeDecision(both, { isError: false }, '\uFFFD', { count: 0 });
assert.equal(outBoth.content, both.content, 'content 必须原样保留：不能同时替换两处');
assert.equal(hasLoneSurrogate(outBoth.value.text), false, 'value 里的孤立代理要清掉');

// 15. 只有 content 命中时改 content
const onlyContent = { kind: 'accept', content: 'y' + HI };
assert.equal(hasLoneSurrogate(neutralizeDecision(onlyContent, { isError: false }, '\uFFFD', { count: 0 }).content), false);

// 16. 只有 value 命中时改 value，且不动 content
const onlyValue = { kind: 'accept', value: 'z' + HI, content: 'clean' };
const ov = neutralizeDecision(onlyValue, { isError: false }, '\uFFFD', { count: 0 });
assert.equal(ov.content, 'clean');
assert.equal(hasLoneSurrogate(ov.value), false);

// 17. value / content 都干净、坏字符只在 result.meta 时，走 meta 分支
const metaOnly = neutralizeDecision({ kind: 'accept', value: 'ok', content: 'ok' },
  { isError: false, meta: { lines: [{ number: 1, text: HI }] } }, '\uFFFD', { count: 0 });
assert.ok(metaOnly.meta, '应回带 meta');
assert.equal(hasLoneSurrogate(metaOnly.meta.lines[0].text), false);
assert.equal(metaOnly.value, 'ok');
assert.equal(metaOnly.content, 'ok');

console.log('surrogate-guard: 17 项离线检查全部通过');