/**
 * @file object-store.ts
 * @description 腾讯云 COS 对象存储卸载层：把最终成品 M4B 上传到 COS，并按需签发限时下载 URL。
 *
 * 设计动机：生产服务器公网出口被整形在 5 Mbps，下载大文件穿这条窄管极慢。改为把成品卸载到
 * COS 的独立出口——下载接口返回一个预签名 URL（302 跳转），客户端直连 COS 拉取，彻底绕开 5M。
 *
 * 关键架构点——上传与下载使用**不同域名**：
 * - **上传**走内网域名 `{Bucket}.cos-internal.{Region}.tencentcos.cn`：同地域 ECS→COS 内网流量
 *   免费、不占公网 5M、速度可达几十 MB/s。由 {@link Config.COS_USE_INTERNAL_UPLOAD} 控制
 *   （本地非同地域开发置 false 退回公网域名）。
 * - **下载预签名**走默认公网域名 `{Bucket}.cos.{Region}.myqcloud.com`：外部用户可直达，
 *   私有桶凭 URL 内的临时签名放行单个对象的读取。
 * 因此本模块持有两个 COS 客户端实例（共用密钥）：{@link uploadCos} 与 {@link signCos}。
 *
 * 启用开关：仅当 `config.COS_BUCKET` 非空才启用（{@link isEnabled}）；为空时整套卸载禁用，
 * 调用方据此退回本地流式下载，保证本地开发与未配置环境不受影响。
 */

import COS from 'cos-nodejs-sdk-v5';
import { config } from '../config.js';

/** COS 内网上传域名模板：同地域内网传输，免费且不占公网带宽。 */
const INTERNAL_DOMAIN_TEMPLATE = '{Bucket}.cos-internal.{Region}.tencentcos.cn';

/**
 * 腾讯云 COS 卸载层。详见文件头说明。
 */
export class CosObjectStore {
  /** 上传客户端：内网域名（或公网，取决于 `COS_USE_INTERNAL_UPLOAD`）。 */
  private readonly uploadCos?: COS;
  /** 签名客户端：默认公网域名，用于签发外部可达的下载 URL。 */
  private readonly signCos?: COS;

  constructor() {
    // 未配置桶则不实例化任何客户端——整套卸载禁用，调用方退回本地流式
    if (!this.isEnabled()) return;

    const credentials = {
      SecretId: config.COS_SECRET_ID,
      SecretKey: config.COS_SECRET_KEY,
    };

    // 上传客户端：生产同地域走内网域名（免费、不占 5M）；本地开发关闭则不传 Domain 走默认公网
    this.uploadCos = new COS({
      ...credentials,
      ...(config.COS_USE_INTERNAL_UPLOAD ? { Domain: INTERNAL_DOMAIN_TEMPLATE } : {}),
    });
    // 签名客户端：默认公网域名，签出的 URL 外部用户可直达
    this.signCos = new COS(credentials);
  }

  /** 是否启用 COS 卸载：`COS_BUCKET` 非空即启用。 */
  public isEnabled(): boolean {
    return Boolean(config.COS_BUCKET);
  }

  /**
   * 上传本地文件到 COS。使用 `uploadFile` 高级上传——SDK 按 `SliceSize` 阈值自动在简单/分片
   * 上传间切换，大文件自动分片、可断点。
   *
   * @param localPath 本地文件绝对路径
   * @param key 目标对象键（如 `audiobooks/<jobId>.m4b`）
   */
  public async uploadFile(localPath: string, key: string): Promise<void> {
    if (!this.uploadCos) throw new Error('COS 未启用，无法上传');
    await new Promise<void>((resolve, reject) => {
      this.uploadCos!.uploadFile(
        {
          Bucket: config.COS_BUCKET,
          Region: config.COS_REGION,
          Key: key,
          FilePath: localPath,
          ContentType: 'audio/mp4',
        },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * 为某对象签发限时下载 URL（私有桶凭此放行单个对象读取）。
   * 通过 `response-content-disposition` / `response-content-type` 让 COS 在响应时强制下载
   * 文件名与音频类型——这些参数已纳入签名，私有桶下依然生效。
   *
   * @param key 对象键
   * @param filename 期望的下载文件名（含扩展名，可为中文）
   * @returns 带签名的下载 URL，有效期 `config.COS_PRESIGN_TTL_S` 秒
   */
  public async getPresignedUrl(key: string, filename: string): Promise<string> {
    if (!this.signCos) throw new Error('COS 未启用，无法签发下载 URL');
    // 复用与本地下载一致的 RFC 5987 中文文件名编码
    const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
    return new Promise<string>((resolve, reject) => {
      this.signCos!.getObjectUrl(
        {
          Bucket: config.COS_BUCKET,
          Region: config.COS_REGION,
          Key: key,
          Sign: true,
          Expires: config.COS_PRESIGN_TTL_S,
          Query: {
            'response-content-disposition': disposition,
            'response-content-type': 'audio/mp4',
          },
        },
        (err, data) => (err ? reject(err) : resolve(data.Url)),
      );
    });
  }
}

/** 进程级单例：并发池、客户端在实例上共享。 */
export const objectStore = new CosObjectStore();
