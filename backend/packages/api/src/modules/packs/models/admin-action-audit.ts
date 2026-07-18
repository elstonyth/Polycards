import { model } from '@medusajs/framework/utils';

// admin_action_audit — append-only record of every admin money mutation
// (Phase 3a). admin_id is server-derived (auth_context.actor_id), reason is
// mandatory. No update/delete route — append-only by convention. The
// framework-added deleted_at column is never used.
export const AdminActionAudit = model
  .define('admin_action_audit', {
    id: model.id().primaryKey(),
    admin_id: model.text(),
    entity_type: model.enum([
      'customer',
      'commission',
      'rewards_settings',
      'credit',
      'reward_pool',
      'daily_reward_settings',
      'daily_box',
      'voucher_ladder',
      'fx',
      'site_settings',
      'vip_levels',
    ]),
    entity_id: model.text(),
    action: model.enum([
      'freeze',
      'unfreeze',
      'reverse_commission',
      'suspend_commission',
      'unsuspend_commission',
      'adjust_credit',
      'edit_rewards_settings',
      'edit_reward_pool',
      'edit_daily_reward_settings',
      'edit_daily_box',
      'edit_voucher_ladder',
      'edit_fx_rate',
      'edit_site_settings',
      'edit_avatar_frames',
      'replace',
    ]),
    before: model.json().nullable(),
    after: model.json().nullable(),
    reason: model.text(),
  })
  .indexes([
    {
      name: 'IDX_admin_action_audit_admin_id',
      on: ['admin_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_admin_action_audit_entity',
      on: ['entity_type', 'entity_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_admin_action_audit_created_at',
      on: ['created_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default AdminActionAudit;
