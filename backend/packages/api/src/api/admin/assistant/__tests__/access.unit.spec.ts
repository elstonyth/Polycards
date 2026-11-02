import type { MedusaContainer } from '@medusajs/framework/types';
import { accessFor, allowedTools } from '../access';
import { TOOLS } from '../tools';

// The roles as they stand in production (memory: admin-limited-role-sidebar),
// as policy sets. Anson holds three roles plus the assistant grant; yu holds
// the Support viewer role plus the assistant grant without browse.
const POLICIES: Record<string, string[]> = {
  role_super_admin: ['*:*'],
  automation_operator: ['automation:read', 'automation:update', 'store:read'],
  order_manager: [
    'delivery_order:read',
    'delivery_order:update',
    'pull:read',
    'media:update',
  ],
  stock_keeper: [
    'store:read',
    'inventory:read',
    'inventory_item:read',
    'goods_receive_note:read',
    'goods_receive_note:update',
    'purchase_invoice:read',
    'purchase_invoice:update',
    'procurement:read',
    'product:read',
    'product:create',
    'pricecharting:read',
    'tcg:read',
    'pricing:read',
    'media:update',
  ],
  support_viewer: [
    'store:read',
    'customer:read',
    'player:read',
    'payment:read',
    'delivery_order:read',
    'ledger:read',
    'pull:read',
    'pack_gift:read',
    'lucky_draw:read',
  ],
  assistant_user: ['assistant:read', 'assistant:update', 'assistant:delete'],
  assistant_browser: ['assistant_browse:read'],
  desk_bots: ['*:read'],
};

// Like the real one, it answers yes for an empty role list: access.ts must
// guard that itself.
jest.mock('@medusajs/framework', () => ({
  hasPermission: jest.fn(
    async ({
      roles,
      actions,
    }: {
      roles: string[];
      actions: { resource: string; operation: string };
    }) =>
      roles.length === 0 ||
      roles.some((r) =>
        (POLICIES[r] ?? []).some((p) => {
          const [res, op] = p.split(':');
          return (
            (res === '*' || res === actions.resource) &&
            (op === '*' || op === actions.operation)
          );
        }),
      ),
  ),
}));

const container = {} as MedusaContainer;
const toolsOf = async (roles: unknown) =>
  (
    await allowedTools(
      accessFor(container, { actor_id: 'user_1', app_metadata: { roles } }),
      TOOLS,
    )
  ).map((t) => t.name);

describe('assistant access', () => {
  it('gives a super admin every tool, raw SQL and images included', async () => {
    expect(await toolsOf(['role_super_admin'])).toEqual(
      TOOLS.map((t) => t.name),
    );
  });

  it('gives Anson (stock, orders, automation) stock and order tools, no money', async () => {
    expect(
      await toolsOf([
        'automation_operator',
        'order_manager',
        'stock_keeper',
        'assistant_user',
        'assistant_browser',
      ]),
    ).toEqual([
      'order',
      'low_stock',
      'admin_read',
      'remember',
      'recall',
      'forget',
      'search_chats',
      'schedule_task',
      'list_schedules',
      'cancel_schedule',
    ]);
  });

  it('gives yu (Support viewer) one-customer tools only: no lists, no SQL', async () => {
    expect(await toolsOf(['support_viewer', 'assistant_user'])).toEqual([
      'player',
      'account',
      'order',
      'remember',
      'recall',
      'forget',
      'search_chats',
      'schedule_task',
      'list_schedules',
      'cancel_schedule',
    ]);
  });

  it('gives nothing to a session with no roles (hasPermission([]) would say yes)', async () => {
    expect(await toolsOf([])).toEqual([]);
    expect(await toolsOf(undefined)).toEqual([]);
    expect(await toolsOf(['', 42])).toEqual([]);
  });

  it('never treats read-everything as super admin: no SQL, no images', async () => {
    const tools = await toolsOf(['desk_bots']);
    expect(tools).not.toContain('db_query');
    expect(tools).not.toContain('generate_image');
    expect(tools).toContain('economy');
  });

  it('gives every tool at least one need', () => {
    for (const tool of TOOLS)
      expect([tool.name, tool.needs.length > 0]).toEqual([tool.name, true]);
  });

  it('offers a tool with no needs to nobody, super admins included', async () => {
    const access = accessFor(container, {
      actor_id: 'user_1',
      app_metadata: { roles: ['role_super_admin'] },
    });
    expect(await allowedTools(access, [{ name: 'open', needs: [] }])).toEqual(
      [],
    );
  });

  it('carries the asker id and roles for the loopback token', () => {
    const access = accessFor(container, {
      actor_id: 'user_9',
      auth_identity_id: 'authid_9',
      app_metadata: { roles: ['support_viewer'] },
    });
    expect(access).toMatchObject({
      userId: 'user_9',
      authIdentityId: 'authid_9',
      roles: ['support_viewer'],
      superAdmin: false,
    });
  });
});
