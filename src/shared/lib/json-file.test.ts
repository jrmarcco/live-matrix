import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readJsonFile, writeJsonFile } from './json-file';

const dirs: string[] = [];

function tmpFile(name = 'data.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lm-json-'));
  dirs.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('json-file', () => {
  it('写入后可读回（含嵌套目录自动创建、pretty 格式）', () => {
    const file = path.join(tmpFile(), 'nested', 'deep', 'data.json');
    writeJsonFile(file, { version: 1, items: [{ a: 1 }] });
    expect(readJsonFile<{ version: number; items: unknown[] }>(file)).toEqual({ version: 1, items: [{ a: 1 }] });
    // pretty-print（2 空格缩进）便于用户直接查看/手工备份
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "version": 1');
  });

  it('文件不存在或损坏时读取返回 null（调用方落默认值）', () => {
    expect(readJsonFile(tmpFile())).toBeNull();
    const file = tmpFile();
    fs.writeFileSync(file, '{oops', 'utf8');
    expect(readJsonFile(file)).toBeNull();
  });

  it('写入失败只记日志不抛出（如路径指向目录）', () => {
    const dirAsFile = tmpFile();
    fs.mkdirSync(dirAsFile, { recursive: true });
    expect(() => writeJsonFile(dirAsFile, { a: 1 })).not.toThrow();
  });
});
