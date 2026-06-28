/**
 * @file object-store.test.ts
 * @description CosObjectStore 的离线单元测试。mock 掉 cos-nodejs-sdk-v5 与全局 config，
 * 验证：启用开关、内网/公网域名选择、uploadFile 参数与回调 promisify、
 * 预签名 URL 携带 response-content-disposition（含中文文件名编码）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 可控 mock：COS SDK 的构造、uploadFile、getObjectUrl
const mocks = vi.hoisted(() => ({
  cosCtor: vi.fn(),
  uploadFile: vi.fn(),
  getObjectUrl: vi.fn(),
}));

vi.mock('cos-nodejs-sdk-v5', () => ({
  default: class {
    uploadFile = mocks.uploadFile;
    getObjectUrl = mocks.getObjectUrl;
    constructor(opts: unknown) {
      mocks.cosCtor(opts);
    }
  },
}));

// 可变 config：各用例按需改字段以驱动不同分支
const cfg = vi.hoisted(() => ({
  config: {
    COS_SECRET_ID: 'sid',
    COS_SECRET_KEY: 'skey',
    COS_BUCKET: 'audiobook-1250000000',
    COS_REGION: 'ap-guangzhou',
    COS_KEY_PREFIX: 'audiobooks/',
    COS_PRESIGN_TTL_S: 3600,
    COS_USE_INTERNAL_UPLOAD: true,
  },
}));

vi.mock('../../src/config.js', () => ({ config: cfg.config }));

import { CosObjectStore } from '../../src/services/object-store.js';

beforeEach(() => {
  vi.clearAllMocks();
  // 还原默认（启用 + 内网上传）
  cfg.config.COS_BUCKET = 'audiobook-1250000000';
  cfg.config.COS_USE_INTERNAL_UPLOAD = true;
});

describe('CosObjectStore.isEnabled', () => {
  it('COS_BUCKET 为空时禁用，且不构造任何 COS 客户端', () => {
    cfg.config.COS_BUCKET = '';
    const store = new CosObjectStore();
    expect(store.isEnabled()).toBe(false);
    expect(mocks.cosCtor).not.toHaveBeenCalled();
  });

  it('COS_BUCKET 非空时启用，并构造上传与签名两个客户端', () => {
    const store = new CosObjectStore();
    expect(store.isEnabled()).toBe(true);
    expect(mocks.cosCtor).toHaveBeenCalledTimes(2);
  });
});

describe('域名选择', () => {
  it('内网上传开启时，上传客户端用 cos-internal 模板域名，签名客户端不带 Domain', () => {
    cfg.config.COS_USE_INTERNAL_UPLOAD = true;
    new CosObjectStore();
    const calls = mocks.cosCtor.mock.calls.map((c) => c[0] as { Domain?: string });
    const uploadOpts = calls.find((o) => o.Domain !== undefined);
    const signOpts = calls.find((o) => o.Domain === undefined);
    expect(uploadOpts?.Domain).toBe('{Bucket}.cos-internal.{Region}.tencentcos.cn');
    expect(signOpts).toBeDefined();
  });

  it('内网上传关闭时，两个客户端均不带 Domain（走默认公网）', () => {
    cfg.config.COS_USE_INTERNAL_UPLOAD = false;
    new CosObjectStore();
    const calls = mocks.cosCtor.mock.calls.map((c) => c[0] as { Domain?: string });
    expect(calls.every((o) => o.Domain === undefined)).toBe(true);
  });
});

describe('uploadFile', () => {
  it('以正确参数调用 SDK uploadFile 并在回调成功时 resolve', async () => {
    mocks.uploadFile.mockImplementation((_params: unknown, cb: (e: unknown) => void) => cb(null));
    const store = new CosObjectStore();
    await expect(
      store.uploadFile('/tmp/x/output.m4b', 'audiobooks/x.m4b'),
    ).resolves.toBeUndefined();

    const params = mocks.uploadFile.mock.calls[0][0];
    expect(params).toMatchObject({
      Bucket: 'audiobook-1250000000',
      Region: 'ap-guangzhou',
      Key: 'audiobooks/x.m4b',
      FilePath: '/tmp/x/output.m4b',
      ContentType: 'audio/mp4',
    });
  });

  it('回调返回错误时 reject', async () => {
    const boom = new Error('网络中断');
    mocks.uploadFile.mockImplementation((_params: unknown, cb: (e: unknown) => void) => cb(boom));
    const store = new CosObjectStore();
    await expect(store.uploadFile('/tmp/x/output.m4b', 'audiobooks/x.m4b')).rejects.toThrow(
      '网络中断',
    );
  });

  it('未启用时调用直接抛错', async () => {
    cfg.config.COS_BUCKET = '';
    const store = new CosObjectStore();
    await expect(store.uploadFile('/a', 'k')).rejects.toThrow(/未启用/);
  });
});

describe('getPresignedUrl', () => {
  it('签发 URL 并携带 response-content-disposition（中文文件名 RFC5987 编码）', async () => {
    mocks.getObjectUrl.mockImplementation(
      (_params: unknown, cb: (e: unknown, d: { Url: string }) => void) =>
        cb(null, { Url: 'https://signed.example/cos?sig=1' }),
    );
    const store = new CosObjectStore();
    const url = await store.getPresignedUrl('audiobooks/x.m4b', '测试书名.m4b');
    expect(url).toBe('https://signed.example/cos?sig=1');

    const params = mocks.getObjectUrl.mock.calls[0][0];
    expect(params).toMatchObject({
      Bucket: 'audiobook-1250000000',
      Region: 'ap-guangzhou',
      Key: 'audiobooks/x.m4b',
      Sign: true,
      Expires: 3600,
    });
    const disposition = params.Query['response-content-disposition'];
    expect(disposition).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('测试书名.m4b')}`);
    expect(params.Query['response-content-type']).toBe('audio/mp4');
  });

  it('回调返回错误时 reject', async () => {
    mocks.getObjectUrl.mockImplementation(
      (_params: unknown, cb: (e: unknown, d?: { Url: string }) => void) =>
        cb(new Error('签名失败')),
    );
    const store = new CosObjectStore();
    await expect(store.getPresignedUrl('k', 'a.m4b')).rejects.toThrow('签名失败');
  });
});
