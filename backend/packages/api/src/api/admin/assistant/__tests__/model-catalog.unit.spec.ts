import { forgetModelCatalog, modelCatalog } from '../openrouter';

// The dropdowns in Settings → AI assistant: which of OpenRouter's models each
// field may take, kept an hour, the last good list through a failure.

const text = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    supported_parameters: ['tools', 'max_tokens'],
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
  },
  {
    id: 'google/gemini-3.5-flash-lite',
    supported_parameters: ['tools'],
    architecture: {
      input_modalities: ['text', 'audio'],
      output_modalities: ['text'],
    },
  },
  // no tools: can't run the assistant's steps
  {
    id: 'some/plain-chat',
    supported_parameters: ['max_tokens'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  // search built in: refused everywhere (an outside channel)
  {
    id: 'perplexity/sonar-pro',
    supported_parameters: ['tools'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'openai/gpt-4o-search-preview',
    supported_parameters: ['tools'],
    architecture: {
      input_modalities: ['text', 'audio'],
      output_modalities: ['text'],
    },
  },
];
const image = [
  {
    id: 'google/gemini-3.1-flash-image',
    architecture: { output_modalities: ['image', 'text'] },
  },
  {
    id: 'black-forest-labs/flux-3-image',
    architecture: { output_modalities: ['image'] },
  },
];
const lists = (t: unknown[] | null, i: unknown[] | null) =>
  jest.fn(async (url: unknown) => {
    const data = String(url).includes('output_modalities=image') ? i : t;
    return data
      ? new Response(JSON.stringify({ data }))
      : new Response('{}', { status: 503 });
  }) as unknown as typeof fetch;

beforeEach(() => {
  forgetModelCatalog();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

it('offers each field the models that can do its job', async () => {
  expect(await modelCatalog(lists(text, image))).toEqual({
    chat: ['anthropic/claude-sonnet-5.5', 'google/gemini-3.5-flash-lite'],
    image: ['black-forest-labs/flux-3-image', 'google/gemini-3.1-flash-image'],
    listen: ['google/gemini-3.5-flash-lite'],
  });
});

it('keeps the list an hour, and the last good one through a failure', async () => {
  const good = lists(text, image);
  await modelCatalog(good);
  jest.advanceTimersByTime(59 * 60_000);
  await modelCatalog(good);
  expect(good).toHaveBeenCalledTimes(2); // both lists, once
  jest.advanceTimersByTime(2 * 60_000);
  const down = lists(null, null);
  expect((await modelCatalog(down))?.chat).toContain(
    'anthropic/claude-sonnet-5.5',
  );
  jest.advanceTimersByTime(30_000);
  await modelCatalog(down);
  expect(down).toHaveBeenCalledTimes(2); // retried a minute later, not sooner
});

it('is null until a list has been had', async () => {
  expect(await modelCatalog(lists(null, null))).toBeNull();
});
