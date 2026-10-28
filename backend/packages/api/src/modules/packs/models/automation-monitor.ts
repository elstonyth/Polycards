import { model } from '@medusajs/framework/utils';

// Selection only: no credentials, run state, or financial configuration.
export const AutomationMonitor = model.define('automation_monitor', {
  id: model.id().primaryKey(),
  accounts: model.json(),
  updated_by: model.text(),
});

export default AutomationMonitor;
