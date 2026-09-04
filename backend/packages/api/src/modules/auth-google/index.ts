import { ModuleProvider, Modules } from '@medusajs/framework/utils';
import GoogleAuthWithRetryService from './service';

/**
 * Replaces `@medusajs/auth-google` in medusa-config.ts. Same provider id, same
 * options, same behaviour — plus one retry when the token exchange never
 * reaches Google. See ./service.ts for why that retry is safe.
 */
export default ModuleProvider(Modules.AUTH, {
  services: [GoogleAuthWithRetryService],
});
