import { useRef, useState, type ChangeEvent } from 'react';
import {
  Button,
  Container,
  Heading,
  Input,
  Select,
  Text,
  Textarea,
  toast,
} from '@medusajs/ui';
import { Photo } from '@medusajs/icons';
import type { RouteConfig } from '@mercurjs/dashboard-sdk';
import {
  useSaveSiteSettings,
  useSiteSettings,
  useUploadImage,
} from '../../lib/queries';
import { validateImageFile } from '../../lib/image-validation';
import { resolveImageUrl } from '../../lib/image-url';
import { FxCard } from './FxCard';

// ─── AI frame-prompt templates ───────────────────────────────────────────────
// Paste into any image model (Gemini, GPT, Midjourney …). Every template
// renders the card window + background in flat #FF00FF — POST /admin/media
// keys that magenta to transparency automatically on upload, so the model's
// output can be uploaded here directly.

const PROMPT_CORE = `Portrait orientation, proportions 3.31 wide by 5.35 tall like a real card grading slab, viewed perfectly straight-on (orthographic, no perspective tilt), centered in frame. The label plate sits at the top of the slab taking up roughly the top quarter; the card window opens directly below it with about 8-10% clear plastic border on each side.

CRITICAL: the large card window (the area below the label where the card would sit) must be a completely flat, solid, uniform bright magenta color #FF00FF with no reflections, no gradients, no shadows, nothing inside. The entire background surrounding the slab must also be the same flat solid magenta #FF00FF.

The only rendered object is the slab shell: the clear plastic frame, the label plate, and the plastic edge highlights. No hands, no table, no drop shadows, no watermark, no extra text.

Style: high-end product photography, studio lighting, ultra sharp, 4K detail.`;

const PROMPT_TEMPLATES: { id: string; label: string; prompt: string }[] = [
  {
    id: 'psa-white',
    label: 'PSA white label (attach the PSA logo image)',
    prompt: `A photorealistic front-facing graded trading card slab case in premium clear acrylic with crisp beveled edges and subtle glossy rim highlights.

At the top is an integrated label plate with a clean WHITE background, like a real PSA grading label. On its left, reproduce the ATTACHED PSA LOGO EXACTLY — bold blue "P" and "A" with the red brushstroke "S" — keeping its exact colors and proportions. To its right, a large bold "10" in the same deep blue. Below, a smaller line "AUTHENTICATED · GRADED GEM" in dark grey, and a small serial "NO. 0001982" in the label corner. A thin holographic security strip runs along the label's top edge.

${PROMPT_CORE}`,
  },
  {
    id: 'pokenic-gold',
    label: 'Pokenic black & gold',
    prompt: `A photorealistic front-facing graded trading card slab case in premium clear acrylic with crisp beveled edges and subtle glossy rim highlights — expensive, museum-grade feel.

At the top is an integrated label plate: deep matte black with "POKENIC" in bold condensed uppercase metallic gold foil, below it a smaller line "AUTHENTICATED · GRADED GEM" in fine silver lettering, a thin holographic security strip along one edge, and a small embossed serial "NO. 0001982" in the corner. The plastic highlights read cold white-silver, not warm.

${PROMPT_CORE}`,
  },
  {
    id: 'minimal-crystal',
    label: 'Minimal crystal (no logo)',
    prompt: `A photorealistic front-facing graded trading card slab case in flawless clear acrylic, minimalist and architectural, with precise beveled edges and the faintest cool rim light.

At the top is a slim frosted-glass label plate with only two elements: "GEM MINT 10" in thin dark charcoal uppercase letterspaced type, and a tiny serial "NO. 0001982" bottom-right. No logos, no color accents — Scandinavian-minimal, gallery-grade restraint.

${PROMPT_CORE}`,
  },
  {
    id: 'holo-prism',
    label: 'Holo prism (dark + rainbow foil)',
    prompt: `A photorealistic front-facing graded trading card slab case in premium clear acrylic with crisp beveled edges, cool studio rim highlights, and a subtly dark, dramatic mood.

At the top is an integrated label plate finished ENTIRELY in holographic rainbow prism foil that shifts cyan-violet-gold. Embossed on the foil: "PRISTINE 10" in bold silver mirror lettering, a smaller "AUTHENTICATED · GRADED GEM" line beneath it, and a small serial "NO. 0001982" in the corner.

${PROMPT_CORE}`,
  },
];

// Storefront presentation settings. Currently one knob: the slab frame the
// backend bakes into every graded card's photo (PSA-style case; saving
// re-bakes all graded cards). Frames are uploaded through the validated
// /admin/media gate ('frame' profile: slab proportions ≈ 0.62, transparent
// card window recommended).
const StorefrontPage = () => {
  const { data, isError } = useSiteSettings();
  const save = useSaveSiteSettings();
  const upload = useUploadImage();
  const fileRef = useRef<HTMLInputElement>(null);
  // undefined = untouched; null = reset to bundled default; string = new URL
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [templateId, setTemplateId] = useState(PROMPT_TEMPLATES[0].id);
  const template =
    PROMPT_TEMPLATES.find((t) => t.id === templateId) ?? PROMPT_TEMPLATES[0];

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(template.prompt);
      toast.success('Prompt copied');
    } catch {
      toast.error('Could not copy — select the text manually.');
    }
  };

  const current = data?.slab_frame_url ?? null;
  const effective = pending === undefined ? current : pending;
  const dirty = pending !== undefined && pending !== current;
  const canSave = dirty && !save.isPending && reason.trim().length > 0;

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side gate: instant reject before the upload round-trip. The
    // server re-validates (and is authoritative).
    const problem = await validateImageFile(file, 'frame');
    if (problem) {
      toast.error(problem);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const url = await upload.mutateAsync({ file, kind: 'frame' });
      setPending(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = () => {
    if (!canSave) return;
    save.mutate(
      { slab_frame_url: effective, reason: reason.trim() },
      {
        onSuccess: () => {
          setPending(undefined);
          setReason('');
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-y-3">
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h1">Storefront</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Presentation settings applied to every product on the storefront.
        </Text>
      </div>
      {isError ? (
        <div className="px-6 py-8">
          <Text className="text-ui-fg-subtle">Failed to load settings.</Text>
        </div>
      ) : (
        <div className="flex flex-col gap-y-5 px-6 py-6">
          <div>
            <Heading level="h2">Slab frame</Heading>
            <Text className="text-ui-fg-subtle" size="small">
              Baked into every graded card's photo (blank Grader = raw card, no
              frame). Saving re-bakes all graded cards with this frame. Upload
              a transparent WebP/PNG at slab proportions (≈ 0.62, e.g. 800×1342)
              — or an AI render straight from a prompt template below (its
              magenta window/background is removed automatically). Keep the
              label at the top and the card window in the same position as the
              current frame. Applies to all products immediately — no
              per-product changes needed.
            </Text>
          </div>
          <div className="flex items-start gap-6">
            {/* preview over a dark board, matching the storefront's canvas */}
            <div className="flex h-64 w-40 shrink-0 items-center justify-center rounded-lg bg-neutral-900 p-2">
              {effective ? (
                <img
                  src={resolveImageUrl(effective)}
                  alt="Slab frame preview"
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <Text
                  size="small"
                  className="px-2 text-center text-neutral-400"
                >
                  Storefront default frame
                </Text>
              )}
            </div>
            <div className="flex flex-col gap-y-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFile}
              />
              <Button
                size="small"
                variant="secondary"
                type="button"
                onClick={() => fileRef.current?.click()}
                isLoading={upload.isPending}
              >
                Upload new frame…
              </Button>
              <Button
                size="small"
                variant="secondary"
                type="button"
                onClick={() => setPending(null)}
                disabled={effective === null}
              >
                Reset to default
              </Button>
              {dirty && (
                <Text size="small" className="text-ui-fg-subtle">
                  Unsaved change — add a reason and save.
                </Text>
              )}
            </div>
          </div>
          <div className="flex items-end gap-4">
            <div className="flex min-w-64 flex-1 flex-col gap-y-1">
              <Text size="small" weight="plus">
                Reason
              </Text>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Required — audit note for this change"
              />
            </div>
            <Button
              onClick={submit}
              isLoading={save.isPending}
              disabled={!canSave}
            >
              Save
            </Button>
          </div>

          <div className="border-ui-border-base flex flex-col gap-y-3 border-t pt-5">
            <div>
              <Heading level="h2">AI prompt templates</Heading>
              <Text className="text-ui-fg-subtle" size="small">
                Pick a style, copy the prompt into any image model (Gemini, GPT,
                Midjourney…), then upload the result above as-is. For the PSA
                template, also attach the official PSA logo image to the model
                so it reproduces it exactly.
              </Text>
            </div>
            <div className="flex items-center gap-3">
              <Select value={templateId} onValueChange={setTemplateId}>
                <Select.Trigger className="w-96">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {PROMPT_TEMPLATES.map((t) => (
                    <Select.Item key={t.id} value={t.id}>
                      {t.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
              <Button
                size="small"
                variant="secondary"
                type="button"
                onClick={() => void copyPrompt()}
              >
                Copy prompt
              </Button>
            </div>
            <Textarea
              readOnly
              value={template.prompt}
              rows={12}
              className="font-mono text-xs"
            />
          </div>
        </div>
      )}
    </Container>
    <FxCard />
    </div>
  );
};

export default StorefrontPage;

export const config: RouteConfig = {
  label: 'Storefront',
  icon: Photo,
  rank: 25,
};
