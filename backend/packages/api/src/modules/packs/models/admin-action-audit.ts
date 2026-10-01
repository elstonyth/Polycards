import { model } from '@medusajs/framework/utils';

// The CHECK-constrained value lists, exported so the migration that rewrites
// the DB CHECKs can be tested against them (see
// migrations/__tests__/admin-audit-config-enums.unit.spec.ts). Adding a value
// here is not enough on its own: the CHECK only changes with a migration.
export const ADMIN_AUDIT_ENTITY_TYPES = [
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
  // Partner groups (spec 2026-09-09): group-policy edits audit against the
  // customer group row they change.
  'customer_group',
  // Held-withdrawal approve/deny (plan 132).
  'gateway_withdrawal',
  // Config-change trail (2026-09-30): pack settings, pack odds and card
  // removals, so the odds and buyback rate in force at any past moment can be
  // proven rather than inferred from sales.
  'pack',
  'card',
] as const;

export const ADMIN_AUDIT_ACTIONS = [
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
  // Partner groups (spec 2026-09-09) — see Migration20260909090000.
  'edit_group_policy',
  // Held-withdrawal approve/deny (plan 132).
  'approve_withdrawal',
  'deny_withdrawal',
  // Config-change trail (2026-09-30) — see Migration20260930100000.
  // 'create' / 'edit' above are reused for pack settings.
  'delete',
  'edit_odds',
  'edit_members',
  'edit_top_hits',
  'reorder',
  'edit_odds_set',
  'set_player_group',
] as const;

// admin_action_audit — append-only record of every admin money mutation
// (Phase 3a) and, since 2026-09-30, of every pack / odds / player-group odds
// change. admin_id is server-derived (auth_context.actor_id), reason is
// mandatory. No update/delete route — append-only by convention. The
// framework-added deleted_at column is never used.
export const AdminActionAudit = model
  .define('admin_action_audit', {
    id: model.id().primaryKey(),
    admin_id: model.text(),
    entity_type: model.enum([...ADMIN_AUDIT_ENTITY_TYPES]),
    entity_id: model.text(),
    action: model.enum([...ADMIN_AUDIT_ACTIONS]),
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
