import { describe, expect, it } from 'vitest';
import { detectLiveRoom, detectPlatform, normalizeUrl, PLATFORMS } from './platforms';

describe('normalizeUrl', () => {
  it('无协议时补 https', () => {
    expect(normalizeUrl('live.bilibili.com/12345678')).toBe('https://live.bilibili.com/12345678');
  });

  it('保留已有 http(s) 协议', () => {
    expect(normalizeUrl('https://live.bilibili.com/1')).toBe('https://live.bilibili.com/1');
    expect(normalizeUrl('http://live.douyin.com/2?live_from=share')).toBe('http://live.douyin.com/2?live_from=share');
  });

  it('空白/非 http(s) 返回 null', () => {
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    // 注：'ftp://x' 这类会被宽松拼成 'https://ftp//x'（host=ftp），但 detect* 层仍会拒绝
  });
});

describe('detectPlatform', () => {
  it('识别平台域名及其子域', () => {
    expect(detectPlatform('live.bilibili.com/1')).toBe('bilibili');
    expect(detectPlatform('www.bilibili.com')).toBe('bilibili');
    expect(detectPlatform('live.douyin.com/1')).toBe('douyin');
    expect(detectPlatform('douyin.com')).toBe('douyin');
  });

  it('其他域名返回 null（含 normalizeUrl 宽松拼接出的伪地址）', () => {
    expect(detectPlatform('https://example.com')).toBeNull();
    expect(detectPlatform('https://bilibili.com.evil.com')).toBeNull();
    expect(detectPlatform('ftp://example.com')).toBeNull();
  });
});

describe('detectLiveRoom', () => {
  it('仅接受 live.bilibili.com / live.douyin.com 的数字房间号', () => {
    expect(detectLiveRoom('https://live.bilibili.com/12345678')).toBe('bilibili');
    expect(detectLiveRoom('live.douyin.com/531854687617')).toBe('douyin');
    expect(detectLiveRoom('https://live.bilibili.com/123?live_from=share')).toBe('bilibili');
  });

  it('普通网页/非数字路径/其他子域一律拒绝（不放行打开原始页面）', () => {
    expect(detectLiveRoom('https://www.bilibili.com')).toBeNull();
    expect(detectLiveRoom('https://live.bilibili.com/abc')).toBeNull();
    expect(detectLiveRoom('https://bilibili.com/123')).toBeNull();
    expect(detectLiveRoom('https://example.com/123')).toBeNull();
  });
});

describe('PLATFORMS', () => {
  it('与平台类型保持一致', () => {
    expect(PLATFORMS).toEqual(['bilibili', 'douyin']);
  });
});
