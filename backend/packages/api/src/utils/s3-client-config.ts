/**
 * Extra S3Client config for the DO Spaces / R2 file provider
 * (`additional_client_config`, spread into `new S3Client(...)` by
 * @medusajs/file-s3).
 *
 * The SDK's default request handler has no request timeout, so a stalled
 * object store held an admin upload request open indefinitely (audit
 * 2026-11-11). `requestHandler` as a plain object is turned into the SDK's
 * NodeHttpHandler with these options. `throwOnRequestTimeout` matters: without
 * it, @smithy/node-http-handler 4.x only LOGS a warning when requestTimeout
 * passes and lets the request keep hanging.
 *
 * 60 s covers the largest admin image upload with room; the connect budget is
 * short because a healthy endpoint answers in well under a second.
 */
export const S3_ADDITIONAL_CLIENT_CONFIG = {
  // Cloudflare R2 (and most S3-compatibles) need path-style URLs.
  forcePathStyle: true,
  requestHandler: {
    connectionTimeout: 5_000,
    requestTimeout: 60_000,
    throwOnRequestTimeout: true,
  },
} as const;
