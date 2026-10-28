import { model } from '@medusajs/framework/utils';

// Synthetic state only. No customer, wallet, inventory or payment relationships.
export const AutomationSandbox = model.define('automation_sandbox', {
  id: model.id().primaryKey(),
  state: model.json(),
  updated_by: model.text(),
});

export default AutomationSandbox;
