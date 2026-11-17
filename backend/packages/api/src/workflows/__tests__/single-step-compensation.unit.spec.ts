/**
 * Pins the Medusa behaviour that workflows/README.md ("Single-step workflows")
 * relies on, so an upgrade that changes it fails here instead of silently
 * changing what a compensator does:
 *
 * - A step that throws still has its own compensator called, but with no
 *   data (`undefined`), never the work it did. So a step must undo its own
 *   partial work inline (create-card, update-card,
 *   create-product-from-pricecharting).
 * - A run that succeeds never compensates.
 * - Only cancelling a finished run (or a later step failing) hands the
 *   compensator its data.
 */
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from '@medusajs/framework/workflows-sdk';

jest.setTimeout(30000);

const calls: Array<{ step: string; data: unknown }> = [];

const failing = createStep(
  'single-step-compensation-failing',
  async () => {
    throw new Error('step failed');
  },
  async (data) => {
    calls.push({ step: 'failing', data });
  },
);

const succeeding = createStep(
  'single-step-compensation-succeeding',
  async () => new StepResponse('done', { rowId: 'row_1' }),
  async (data) => {
    calls.push({ step: 'succeeding', data });
  },
);

const twoStepWorkflow = createWorkflow(
  'single-step-compensation-two-step-wf',
  () => {
    succeeding();
    return new WorkflowResponse(failing());
  },
);
const failingWorkflow = createWorkflow(
  'single-step-compensation-failing-wf',
  () => new WorkflowResponse(failing()),
);
const succeedingWorkflow = createWorkflow(
  'single-step-compensation-succeeding-wf',
  () => new WorkflowResponse(succeeding()),
);

beforeEach(() => {
  calls.length = 0;
});

it("calls a throwing step's own compensator with no data, never its work", async () => {
  const { errors } = await failingWorkflow().run({ throwOnError: false });
  expect(errors.map((e) => e.error?.message)).toEqual(['step failed']);
  expect(calls).toEqual([{ step: 'failing', data: undefined }]);
});

it('never compensates a run that succeeds', async () => {
  const { result } = await succeedingWorkflow().run();
  expect(result).toBe('done');
  expect(calls).toEqual([]);
});

it('hands an earlier step its data when a later step throws', async () => {
  const { errors } = await twoStepWorkflow().run({ throwOnError: false });
  expect(errors.map((e) => e.error?.message)).toEqual(['step failed']);
  expect(calls).toEqual([
    { step: 'failing', data: undefined },
    { step: 'succeeding', data: { rowId: 'row_1' } },
  ]);
});

it('hands the compensator its data when a finished run is cancelled', async () => {
  const { transaction } = await succeedingWorkflow().run();
  await succeedingWorkflow().cancel({ transaction });
  expect(calls).toEqual([{ step: 'succeeding', data: { rowId: 'row_1' } }]);
});
