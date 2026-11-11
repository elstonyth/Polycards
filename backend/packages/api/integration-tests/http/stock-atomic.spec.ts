import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { adjustCardStock } from '../../src/modules/packs/card-stock';

jest.setTimeout(240 * 1000);

// The stock counter under concurrency (audit 2026-11-11). Medusa's
// adjustInventory reads the level, then writes an absolute value, so same-card
// adjustments at once lost updates for good. adjustCardStock adds in one
// UPDATE. The level is read back through the inventory module, so a raw twin
// that disagreed with stocked_quantity would fail here too.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('adjustCardStock', () => {
      let inventoryItemId: string;
      let locationId: string;

      beforeEach(async () => {
        const container = getContainer();
        const location = await container
          .resolve(Modules.STOCK_LOCATION)
          .createStockLocations({ name: 'Atomic Stock Warehouse' });
        locationId = location.id;
        const inventory = container.resolve(Modules.INVENTORY);
        const item = await inventory.createInventoryItems({
          sku: 'CARD-ATOMIC-STOCK',
        });
        inventoryItemId = item.id;
        await inventory.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 5,
          },
        ]);
      });

      const stocked = async () => {
        const level = await getContainer()
          .resolve(Modules.INVENTORY)
          .retrieveInventoryLevelByItemAndLocation(inventoryItemId, locationId);
        return Number(level.stocked_quantity);
      };

      it('keeps every one of 20 concurrent decrements', async () => {
        const container = getContainer();
        await Promise.all(
          Array.from({ length: 20 }, () =>
            adjustCardStock(container, inventoryItemId, locationId, -1),
          ),
        );
        // 5 - 20: negative is the operator's "units owed" signal.
        expect(await stocked()).toBe(-15);
      });

      it('nets a mix of concurrent wins and sell-back restores', async () => {
        const container = getContainer();
        await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            adjustCardStock(
              container,
              inventoryItemId,
              locationId,
              i % 4 === 0 ? 1 : -1,
            ),
          ),
        );
        // 4 restores, 12 wins.
        expect(await stocked()).toBe(-3);
      });

      it('leaves a value Medusa itself keeps adjusting from', async () => {
        const container = getContainer();
        await adjustCardStock(container, inventoryItemId, locationId, 3);
        await container
          .resolve(Modules.INVENTORY)
          .adjustInventory(inventoryItemId, locationId, -1);
        expect(await stocked()).toBe(7);
      });

      it('throws NOT_FOUND for a level that does not exist', async () => {
        await expect(
          adjustCardStock(getContainer(), inventoryItemId, 'sloc_missing', -1),
        ).rejects.toThrow(/not found/);
      });
    });
  },
});
