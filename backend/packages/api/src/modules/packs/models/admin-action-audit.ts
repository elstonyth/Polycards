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
      // Historical only — the referral programme that wrote commission-keyed
      // audit rows was removed (ADR 0007). The value stays because rows written
      // before that removal are still in this table, and narrowing the CHECK
      // would fail against them.
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
      'challenge_stages',
      'challenge_settings',
      'delivery_order',
      'purchase_invoice',
      'tier_settings',
      // Referral rebuild (spec 2026-08-24).
      'referral_settings',
      'weekly_settlement',
      'task_definition',
    ]),
    entity_id: model.text(),
    action: model.enum([
      'freeze',
      'unfreeze',
      // Historical only — see the note on entity_type 'commission' above.
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
      'edit_payment_gateway',
      'edit_avatar_frames',
      'replace',
      'edit',
      'bulk_status',
      'disable',
      'enable',
      'create',
      // A read that exposes data the list view masks — see
      // Migration20260812000000.
      'reveal',
      // Customer self-service account deletion. admin_id carries the
      // CUSTOMER's own id for this action — see service.purgeAccountPacksData.
      'delete_account',
      // Referral rebuild (spec 2026-08-24): partner-rate changes audit against
      // entity_type 'customer'; the settlement lifecycle against
      // 'weekly_settlement'; tier-table edits against 'referral_settings'.
      'set_partner_rate',
      'edit_referral_settings',
      'approve_settlement',
      'void_settlement_line',
      'void_settlement',
      'pay_settlement',
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
