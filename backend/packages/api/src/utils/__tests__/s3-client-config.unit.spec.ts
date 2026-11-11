import { S3Client } from '@aws-sdk/client-s3';
import { S3_ADDITIONAL_CLIENT_CONFIG } from '../s3-client-config';

// Built the way @medusajs/file-s3 builds it (config spread into S3Client), so
// this proves the SDK really takes the plain-object handler options, not just
// that the constant holds them.
describe('S3 file client timeouts', () => {
  it('builds a request handler that errors on a stalled request', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://example.invalid',
      credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      ...S3_ADDITIONAL_CLIENT_CONFIG,
    });
    const handler = client.config.requestHandler as unknown as {
      configProvider: Promise<Record<string, unknown>>;
    };
    const resolved = await handler.configProvider;
    expect(resolved).toMatchObject({
      connectionTimeout: 5_000,
      requestTimeout: 60_000,
      throwOnRequestTimeout: true,
    });
    expect(await client.config.forcePathStyle).toBe(true);
    client.destroy();
  });
});
