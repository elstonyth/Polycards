import { Module } from '@medusajs/framework/utils';
import AssistantModuleService from './service';

export const ASSISTANT_MODULE = 'assistant';

export default Module(ASSISTANT_MODULE, {
  service: AssistantModuleService,
});
