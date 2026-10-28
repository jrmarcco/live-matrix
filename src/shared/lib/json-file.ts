import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * JSON 文件读写助手（主进程侧收藏/设置持久化的公共实现；仅 Node 环境，渲染层不引用）。
 * 读取失败返回 null 由调用方落默认值；写入失败只记日志不抛出。
 */

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[live-matrix] 保存 ${path.basename(file)} 失败:`, err);
  }
}
