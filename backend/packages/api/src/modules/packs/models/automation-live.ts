import { model } from '@medusajs/framework/utils';

export const AutomationLive = model.define('automation_live', {
  id: model.id().primaryKey(),
  state: model.json(),
  updated_by: model.text(),
});

export default AutomationLive;
