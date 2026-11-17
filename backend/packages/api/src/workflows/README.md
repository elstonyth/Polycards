# Custom Workflows

## Single-step workflows (kept on purpose)

These workflows wrap exactly one step and are called only from routes and jobs:
`adjust-credits`, `topup-credits`, `buyback-pull`, `create-card`, `update-card`,
`request-delivery`, `update-delivery-order`, `ensure-profile-handle` and
`create-product-from-pricecharting`. A review on 2026-11-17 (architecture
candidate #10) asked whether they should be plain module calls. They stay
workflows. Do not re-suggest removing them without new evidence.

How compensation actually behaves (Medusa 2.19, pinned by
`__tests__/single-step-compensation.unit.spec.ts`):

- When a step's invoke throws, Medusa still calls that step's own compensator,
  but with no data (`undefined`), never the work it did. Every compensator
  here starts with `if (!data) return`, so it does nothing. A step that writes
  more than once must therefore undo its own partial work inline before
  rethrowing. `create-card`, `update-card` and
  `create-product-from-pricecharting` do. `ensure-profile-handle` does not: if
  `claimHandle` throws after `claimUsername` renamed the account, the rename
  stays (a valid username the next call reuses). That is a known gap, left
  as it is.
- The compensator gets its data only when a later step in the same run fails,
  when the workflow runs nested inside another one (not pinned by the spec),
  or when a finished run is cancelled with
  `workflow(container).cancel({ transaction })`. A cancel needs the
  in-memory `transaction` from that `run()`: these workflows set no `store`
  or `retentionTime`, so the Redis workflow engine drops a finished run and a
  cancel by `transactionId` finds nothing. No code here does any of these
  today, so in production these compensators never undo anything.
- They are kept anyway. They are the correct undo for when a step is composed
  into a longer workflow or a run is cancelled, which is the standard Medusa
  shape: the docs' own `create-post` example
  (https://docs.medusajs.com/learn/fundamentals/modules) is a one-step
  workflow with a compensator. Deleting them would remove that safety net and gain nothing.

What the wrappers do not give these callers today: no hooks (`createHook`),
no retries (Medusa's default is 0 and none is configured), no workflow-level
idempotency (replay safety lives in the module, e.g. `replayed` on credit
postings), no lock step, no caller-supplied `transactionId`, no
`emitEventStep` grouping, and no stored run history. They are not kept for
runtime features.

Why the wrappers stay instead of direct module calls:

- Medusa's guidance is that custom API routes perform mutations through
  workflows.
- Callers depend on the workflow error shape: a failed `run()` throws a
  serialized plain object, not an `Error` instance (see `tickLive` in
  `api/utils/automation-live-store.ts`). A direct call would change what
  routes and jobs catch and log.
- A step can grow (for example a real-gateway capture after `topup-credits`)
  without touching any caller.

The exported `*Invoke` functions (`registerCardInvoke`, `updateCardInvoke`,
`updateDeliveryOrderInvoke`, `createProductFromPcInvoke`, ...) are the step
bodies, exported so unit specs can call them without the workflow runtime.

## Medusa scaffold notes

A workflow is a series of queries and actions that complete a task.

The workflow is created in a TypeScript or JavaScript file under the `src/workflows` directory.

> Learn more about workflows in [this documentation](https://docs.medusajs.com/learn/fundamentals/workflows).

For example:

```ts
import {
  createStep,
  createWorkflow,
  WorkflowResponse,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"

const step1 = createStep("step-1", async () => {
  return new StepResponse(`Hello from step one!`)
})

type WorkflowInput = {
  name: string
}

const step2 = createStep(
  "step-2",
  async ({ name }: WorkflowInput) => {
    return new StepResponse(`Hello ${name} from step two!`)
  }
)

type WorkflowOutput = {
  message1: string
  message2: string
}

const helloWorldWorkflow = createWorkflow(
  "hello-world",
  (input: WorkflowInput) => {
    const greeting1 = step1()
    const greeting2 = step2(input)
    
    return new WorkflowResponse({
      message1: greeting1,
      message2: greeting2
    })
  }
)

export default helloWorldWorkflow
```

## Execute Workflow

You can execute the workflow from other resources, such as API routes, scheduled jobs, or subscribers.

For example, to execute the workflow in an API route:

```ts
import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework"
import myWorkflow from "../../../workflows/hello-world"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
) {
  const { result } = await myWorkflow(req.scope)
    .run({
      input: {
        name: req.query.name as string,
      },
    })

  res.send(result)
}
```
