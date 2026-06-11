import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../../modules/packs";
import { registerCardInvoke } from "../create-card";

// The duplicate-registration contract of registerCardInvoke: a product can be
// registered as a gacha card exactly once, and EVERY way a second registration
// loses — the advisory pre-check, or the handle's UNIQUE constraint when two
// requests race past the pre-check together — must surface the same friendly
// DUPLICATE_ERROR, never a raw DB error (which the API layer turns into a 500).

const PRODUCT = {
  id: "prod_1",
  handle: "test-card",
  title: "Test Card",
  status: "published",
  thumbnail: "/images/test-card.webp",
  images: [],
  metadata: {},
};

const INPUT = {
  product_id: "prod_1",
  set: "Base",
  grader: "PSA",
  grade: "9",
  market_value: 25,
};

const EXISTING_CARD = { id: "card_1", handle: "test-card" };

/** Container stub resolving just the modules the duplicate paths touch. */
const buildContainer = (packs: Record<string, jest.Mock>) => {
  const modules: Record<string, unknown> = {
    [PACKS_MODULE]: packs,
    [Modules.PRODUCT]: {
      listProducts: jest.fn().mockResolvedValue([PRODUCT]),
    },
    [ContainerRegistrationKeys.LOGGER]: { warn: jest.fn() },
  };
  return {
    resolve: (key: string) => {
      if (!(key in modules)) {
        throw new Error(`unit stub: unexpected container.resolve("${key}")`);
      }
      return modules[key];
    },
  } as unknown as MedusaContainer;
};

const expectDuplicate = async (run: Promise<unknown>) => {
  const err = await run.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(MedusaError);
  expect((err as MedusaError).type).toBe(MedusaError.Types.DUPLICATE_ERROR);
  expect((err as MedusaError).message).toContain("already registered");
};

describe("registerCardInvoke duplicate handling", () => {
  it("rejects via the pre-check when the card already exists (no create attempted)", async () => {
    const packs = {
      listCards: jest.fn().mockResolvedValue([EXISTING_CARD]),
      createCards: jest.fn(),
    };
    await expectDuplicate(
      registerCardInvoke(INPUT, { container: buildContainer(packs) })
    );
    expect(packs.createCards).not.toHaveBeenCalled();
  });

  it("maps the unique-violation RACE (pre-check passed, insert collided) to the same friendly error", async () => {
    const packs = {
      // 1st call: pre-check sees nothing; 2nd call: the racing winner's row.
      listCards: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([EXISTING_CARD]),
      createCards: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'duplicate key value violates unique constraint "card_handle_unique"'
          )
        ),
    };
    await expectDuplicate(
      registerCardInvoke(INPUT, { container: buildContainer(packs) })
    );
    expect(packs.createCards).toHaveBeenCalledTimes(1);
    expect(packs.listCards).toHaveBeenCalledTimes(2);
  });

  it("surfaces the ORIGINAL insert error even when the recovery re-list also fails", async () => {
    // DB-down scenario: createCards throws AND the duplicate probe throws.
    // The probe's failure must never replace the original fault.
    const dbDown = new Error("connection terminated unexpectedly");
    const packs = {
      listCards: jest
        .fn()
        .mockResolvedValueOnce([]) // pre-check passes
        .mockRejectedValueOnce(new Error("still down")),
      createCards: jest.fn().mockRejectedValue(dbDown),
    };
    await expect(
      registerCardInvoke(INPUT, { container: buildContainer(packs) })
    ).rejects.toBe(dbDown);
  });

  it("rethrows the ORIGINAL error when the insert fails for any non-duplicate reason", async () => {
    const dbDown = new Error("connection terminated unexpectedly");
    const packs = {
      // Pre-check empty, and the re-list after the failure is empty too —
      // this was NOT a duplicate, so masking it as one would hide a real fault.
      listCards: jest.fn().mockResolvedValue([]),
      createCards: jest.fn().mockRejectedValue(dbDown),
    };
    await expect(
      registerCardInvoke(INPUT, { container: buildContainer(packs) })
    ).rejects.toBe(dbDown);
  });
});
