'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import type { Area, CropperProps } from 'react-easy-crop';
import { cropToFile, loadImage, type CropRect } from '@/lib/avatar-crop';
import { useModalA11y } from '@/lib/use-modal-a11y';

// Loaded on demand — the cropper only mounts once someone picks a photo, so
// its ~15 kB stays out of the /me bundle. ssr:false: it measures the DOM.
// The cast restores the optionality of react-easy-crop's defaultProps, which
// next/dynamic's wrapper type drops (it would demand rotation, style, …).
const Cropper = dynamic(() => import('react-easy-crop'), {
  ssr: false,
}) as React.ComponentType<
  Partial<CropperProps> &
    Pick<CropperProps, 'image' | 'crop' | 'zoom' | 'onCropChange'>
>;

/**
 * Round crop step between "pick a photo" and the upload. Mirrors the avatar's
 * on-screen shape (circular, under a 128% frame ring) so what the customer
 * frames here is exactly what the frame will sit around.
 *
 * It also carries the real fix for the "upload failed" reports — see
 * lib/avatar-crop.ts: the exported square is small enough to clear every
 * server-side gate that a raw phone photo trips.
 */
export function AvatarCropper({
  file,
  busy = false,
  onCancel,
  onConfirm,
}: {
  file: File;
  /** Upload in flight — keeps the controls disabled until it resolves. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (cropped: File) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<CropRect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [ready, setReady] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Own the focus trap while cropping: this overlay sits ABOVE the Edit Profile
  // modal, which releases its trap while a crop is in flight. Escape cancels —
  // unless an upload is running, which must not be abandoned half-way.
  useModalA11y(panelRef, true, () => {
    if (!busy && !working) onCancel();
  });

  // One object URL per picked file, revoked on unmount/replacement.
  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    let live = true;
    setUrl(objectUrl);
    setError(null);
    setReady(false);
    imageRef.current = null;
    // Probe the decode so an undecodable file (a .heic picked on desktop
    // Chrome) reports a real reason instead of an empty crop stage. The probe
    // image is NOT retained — the export draws from the cropper's own <img>
    // (setImageRef below), so a 12 MP photo is never held decoded twice.
    loadImage(objectUrl).catch(() => {
      if (live) {
        setError(
          "This photo format isn't supported on this device — try saving it as JPEG or PNG first.",
        );
      }
    });
    return () => {
      live = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  const onCropComplete = useCallback((_: Area, pixels: Area) => {
    setArea(pixels);
  }, []);

  async function confirm() {
    const image = imageRef.current;
    if (!image || !area || working || busy) return;
    setWorking(true);
    try {
      onConfirm(await cropToFile(image, area));
    } catch {
      setError("Couldn't process that photo — try a different one.");
    } finally {
      setWorking(false);
    }
  }

  // Confirm stays disabled until the photo is decoded AND the cropper has
  // reported an area — otherwise the first tap silently does nothing.
  const disabled = busy || working || !!error || !ready || !area;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Crop profile photo"
      tabIndex={-1}
      className="fixed inset-0 z-[130] flex flex-col bg-black outline-none"
    >
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy || working}
          className="px-2 py-1 text-[15px] font-medium text-white/80 hover:text-white disabled:opacity-50"
        >
          Cancel
        </button>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-white/50">
          Crop photo
        </p>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={disabled}
          className="text-chase px-2 py-1 text-[15px] font-semibold hover:brightness-110 disabled:opacity-50"
        >
          {busy || working ? 'Saving…' : 'Confirm'}
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {url && !error && (
          <Cropper
            image={url}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            minZoom={1}
            maxZoom={4}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            // Export from the element the cropper already decoded.
            setImageRef={(ref) => {
              imageRef.current = ref.current;
            }}
            onMediaLoaded={() => setReady(true)}
          />
        )}
        {error && (
          <p
            role="alert"
            className="absolute inset-x-6 top-1/2 -translate-y-1/2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-[13px] font-medium text-red-300"
          >
            {error}
          </p>
        )}
      </div>

      <div className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-4">
        <label className="flex items-center gap-3">
          <span className="text-[12px] font-semibold text-white/50">Zoom</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            disabled={disabled}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="accent-chase h-1 w-full"
          />
        </label>
        <p className="mt-2 text-center text-[12px] text-white/40">
          Drag to reposition · pinch or zoom to resize
        </p>
      </div>
    </div>,
    document.body,
  );
}
