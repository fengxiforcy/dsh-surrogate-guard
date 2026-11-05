/**
 * lib/vaccine.js —— 存量会话「疫苗」：扫描并修复已经写进会话日志的孤立代理。
 *
 * 背景：dsh-surrogate-guard 的钩子只覆盖「进入会话之前」的路径；一旦毒已经落盘
 * （例如 2026-11-03 小汐会话，agent/inbox/spliced 里带半个 emoji），钩子就看不到了。
 * 本模块直接读会话文件（多帧 zstd + JSONL），做「体检 + 修复」。
 *
 * 关键约束（来自 2026-11-03 复盘）：
 * 1. 必须扫 **JSON.parse 后的字符串值**里的真实代理码元，**不能**扫原始文本里的
 *    \udXXX 转义（那是字面量，合法）；但修复要回到原始行上删对应的转义。
 *    所以这里的扫描器是「转义感知」的：逐字符解析 JSON 行，识别字符串内的 \uXXXX。
 * 2. 修复后必须校验：帧数一致、每行 JSON 可解析、扫描无孤立。
 * 3. 先备份，再写回。
 *
 * 成本：**逐帧流式处理**，内存峰值 ≈ 压缩文件大小 + 最大单帧解压大小，
 * 不把整个会话解压进内存（8.3MB 会话实测峰值 ~20MB，而不是 100MB+）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 切出所有 zstd 帧（按 magic 定位）。 */
export function splitFrames(buf) {
  const idx = [];
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) idx.push(i);
  }
  if (!idx.length) return [buf];
  if (idx[0] !== 0) idx.unshift(0);
  const frames = [];
  for (let i = 0; i < idx.length; i += 1) {
    const end = i + 1 < idx.length ? idx[i + 1] : buf.length;
    frames.push(buf.subarray(idx[i], end));
  }
  return frames;
}

function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }

/**
 * 在一条 JSON 行里找孤立的 \uXXXX 转义（只认字符串内、单反斜杠）。
 * @returns Array<{ index: number, length: 6, code: number }>
 */
export function findLoneEscapes(line) {
  const hits = [];
  let inString = false;
  let pendingHigh = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (!inString) {
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '\\') {
      const next = line[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(line.slice(i + 2, i + 6))) {
        const code = parseInt(line.slice(i + 2, i + 6), 16);
        if (isHigh(code)) {
          if (pendingHigh) hits.push(pendingHigh);
          pendingHigh = { index: i, length: 6, code };
        } else if (isLow(code)) {
          if (pendingHigh) pendingHigh = null;
          else hits.push({ index: i, length: 6, code });
        } else if (pendingHigh) {
          hits.push(pendingHigh);
          pendingHigh = null;
        }
        i += 5;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = false;
      if (pendingHigh) { hits.push(pendingHigh); pendingHigh = null; }
      continue;
    }
  }
  if (pendingHigh) hits.push(pendingHigh);
  return hits;
}

/** 解压单帧为文本。 */
function frameText(frame) {
  try { return zlib.zstdDecompressSync(frame).toString('utf8'); }
  catch (e) { throw new Error('解压失败：' + (e?.message || e)); }
}

/**
 * 扫描一个会话文件（逐帧，不整份解压）。
 * @returns {{ file, frames, lines, hits: Array<{frame,line,index,code,context}> }}
 */
export function scanSession(file) {
  const buf = fs.readFileSync(file);
  const frames = splitFrames(buf);
  const hits = [];
  let lineCount = 0;
  for (let fi = 0; fi < frames.length; fi += 1) {
    const lines = frameText(frames[fi]).split('\n');
    for (let li = 0; li < lines.length; li += 1) {
      const line = lines[li];
      if (!line.trim()) continue;
      lineCount += 1;
      for (const hit of findLoneEscapes(line)) {
        hits.push({
          frame: fi,
          line: lineCount,
          index: hit.index,
          code: hit.code,
          context: line.slice(Math.max(0, hit.index - 40), Math.min(line.length, hit.index + 46)),
        });
      }
    }
  }
  return { file, frames: frames.length, lines: lineCount, hits };
}

/**
 * 修复一个会话文件：备份 → 删孤立转义 → 逐帧重压缩 → 校验。
 * @param file 会话文件
 * @param options { backup?: boolean, dryRun?: boolean }
 */
export function fixSession(file, options = {}) {
  const buf = fs.readFileSync(file);
  const frames = splitFrames(buf);
  const report = { file, frames: frames.length, lines: 0, hits: 0, fixed: 0, backup: null };
  const chunks = [];

  for (const frame of frames) {
    const lines = frameText(frame).split('\n');
    const outLines = [];
    for (const line of lines) {
      if (!line.trim()) { outLines.push(line); continue; }
      report.lines += 1;
      const found = findLoneEscapes(line);
      if (!found.length) { outLines.push(line); continue; }
      report.hits += found.length;
      let next = line;
      for (let i = found.length - 1; i >= 0; i -= 1) {
        next = next.slice(0, found[i].index) + next.slice(found[i].index + found[i].length);
        report.fixed += 1;
      }
      try { JSON.parse(next); } catch { throw new Error('修复后 JSON 解析失败'); }
      if (findLoneEscapes(next).length) throw new Error('修复后仍有孤立转义');
      outLines.push(next);
    }
    chunks.push(zlib.zstdCompressSync(Buffer.from(outLines.join('\n'), 'utf8')));
  }

  if (report.hits === 0) return { ...report, changed: false };
  if (options.dryRun) return { ...report, changed: true, dryRun: true };

  if (options.backup !== false) {
    const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, bak);
    report.backup = bak;
  }

  fs.writeFileSync(file, Buffer.concat(chunks));

  const after = scanSession(file);
  if (after.hits.length) throw new Error('写后复核失败：仍有 ' + after.hits.length + ' 处孤立');
  report.after = { frames: after.frames, lines: after.lines, hits: 0 };
  return { ...report, changed: true };
}

/** 在目录下找所有会话文件。 */
export function findSessions(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl.zstd')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}
