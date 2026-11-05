import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { findLoneEscapes, scanSession, fixSession } from '../lib/vaccine.js';

test('findLoneEscapes：检出孤立高代理，合法代理对不误判', () => {
  const lone = '{"text":"a\\uD83Db"}';
  const ok = '{"text":"\\uD83D\\uDE00"}';
  assert.strictEqual(findLoneEscapes(lone).length, 1);
  assert.strictEqual(findLoneEscapes(ok).length, 0);
  // 字面量（双反斜杠）不是转义，不能误判
  const literal = '{"text":"\\\\ud83d"}';
  assert.strictEqual(findLoneEscapes(literal).length, 0);
});

test('scan/fix：造毒会话修复后干净、帧数与行数不变、有备份', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-vaccine-'));
  const file = path.join(tmp, 'session.v4.jsonl.zstd');
  const bad = JSON.stringify({ type: 'agent/inbox/spliced', data: { inserted: [{ content: [{ type: 'text', text: 'x' + String.fromCharCode(0xd83d) + 'y' }] }] } });
  const good = JSON.stringify({ type: 'assistant/message', data: { text: 'ok' } });
  const frames = [
    zlib.zstdCompressSync(Buffer.from(bad + '\n' + good + '\n', 'utf8')),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'turn/end' }) + '\n', 'utf8')),
  ];
  fs.writeFileSync(file, Buffer.concat(frames));

  const s1 = scanSession(file);
  assert.strictEqual(s1.frames, 2);
  assert.strictEqual(s1.hits.length, 1);

  const fixed = fixSession(file, { backup: true });
  assert.strictEqual(fixed.fixed, 1);
  assert.ok(fixed.backup && fs.existsSync(fixed.backup));

  const s2 = scanSession(file);
  assert.strictEqual(s2.hits.length, 0);
  assert.strictEqual(s2.frames, 2);
  assert.strictEqual(s2.lines, s1.lines);
  fs.rmSync(tmp, { recursive: true, force: true });
});
