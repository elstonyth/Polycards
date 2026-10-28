'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Pill, pillVariants } from '@/components/ui/pill';
import { StaticCoin } from '@/components/coin-flip/StaticCoin';
import { CoinFlipHistory } from '@/components/coin-flip/CoinFlipHistory';
import { useTopUp } from '@/components/app-shell/TopUpProvider';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { getVault, type VaultResult } from '@/lib/actions/vault';
import { acceptCoinFlip, getCoinFlipRound, getCoinFlipSettings, quoteCoinFlip } from '@/lib/actions/coin-flip';
import { coinFlipPendingKey, quoteIsLive, type CoinFlipRound } from '@/lib/coin-flip';
import { rm } from '@/lib/format';

type Phase = 'loading' | 'idle' | 'quoting' | 'confirm' | 'armed' | 'submitting' | 'recovering' | 'result';
type SettingsResult = Awaited<ReturnType<typeof getCoinFlipSettings>>;

export function CoinFlipClient({ customerId, initialVault, initialSettings, initialPullId, initialRoundId }: {
  customerId: string; initialVault: VaultResult; initialSettings: SettingsResult;
  initialPullId?: string; initialRoundId?: string;
}) {
  const [vault, setVault] = useState(initialVault);
  const [settings, setSettings] = useState(initialSettings);
  const [selected, setSelected] = useState(initialPullId ?? '');
  const [phase, setPhase] = useState<Phase>('loading');
  const [round, setRound] = useState<CoinFlipRound | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState(initialVault.ok ? '' : initialVault.error);
  const [now, setNow] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const busy = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const resultPanel = useRef<HTMLDivElement>(null);
  const { refreshBalance } = useTopUp();
  const storageKey = coinFlipPendingKey(customerId);
  const items = vault.ok ? vault.items.filter(item => !item.locked) : [];
  const selectedCard = items.find(item => item.pullId === selected);
  const config = settings.ok ? settings.settings : null;
  const live = round ? quoteIsLive(round, now) : false;
  const locked = !['idle', 'result'].includes(phase);

  useModalA11y(panel, phase === 'confirm', () => setPhase('idle'));

  function clearPending(id: string) {
    try { if (localStorage.getItem(storageKey) === id) localStorage.removeItem(storageKey); } catch { /* URL still identifies the receipt. */ }
    setPendingId(null);
  }
  function remember(id: string) {
    let saved = false;
    try { localStorage.setItem(storageKey, id); saved = true; } catch { /* Private browsing may disable storage. */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('round', id);
      window.history.replaceState(window.history.state, '', url);
      saved = true;
    } catch { /* Local storage remains a recovery path. */ }
    if (!saved) throw new Error('Cannot retain the round for recovery.');
    setPendingId(id);
  }
  function settled(receipt: CoinFlipRound) {
    setRound(receipt);
    clearPending(receipt.id);
    setError('');
    setPhase('result');
    setHistoryRevision(value => value + 1);
    void refreshBalance().catch(() => {});
    void getVault().then(setVault).catch(() => {});
    void getCoinFlipSettings().then(setSettings).catch(() => {});
  }
  async function recover(id: string) {
    if (busy.current) return;
    busy.current = true;
    setPendingId(id);
    setPhase('recovering');
    try {
      const response = await getCoinFlipRound(id);
      if (response.ok) {
        setRound(response.round);
        if (response.round.status !== 'quoted') settled(response.round);
        else setError('This flip has no confirmed result yet. Retry the same flip to resolve it.');
      } else setError(response.error);
    } catch { setError('Connection interrupted. Your result is unknown. Check this flip again.'); }
    finally { busy.current = false; }
  }
  useEffect(() => {
    let id = initialRoundId;
    try { id = localStorage.getItem(storageKey) || id; } catch { /* Use the receipt URL. */ }
    if (id) void recover(id);
    else setPhase('idle');
    // Recovery is bound to this authenticated page mount, never to changing UI state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, initialRoundId]);
  useEffect(() => {
    setNow(Date.now());
    if (phase !== 'armed' && phase !== 'confirm') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phase]);
  useEffect(() => { if (phase === 'result') resultPanel.current?.focus(); }, [phase, round?.id]);

  async function review() {
    if (busy.current || locked || !selectedCard || !config?.eligible) return;
    busy.current = true;
    setPhase('quoting'); setError('');
    try {
      const response = await quoteCoinFlip(selectedCard.pullId);
      if (response.ok) { setRound(response.round); setNow(Date.now()); setPhase('confirm'); }
      else { setError(response.error); setPhase('idle'); }
    } catch { setError('Could not load a quote. Your card has not been committed.'); setPhase('idle'); }
    finally { busy.current = false; }
  }
  async function flip(retry = false) {
    const id = retry ? pendingId : round?.id;
    if (busy.current || !id || (!retry && (phase !== 'armed' || !round || !quoteIsLive(round, Date.now())))) return;
    busy.current = true;
    try {
      remember(id);
    } catch { setError('Enable browser storage before starting a flip.'); busy.current = false; return; }
    setPhase('submitting'); setError('');
    try {
      const response = await acceptCoinFlip(id);
      if (response.ok && response.round.status !== 'quoted') settled(response.round);
      else if (!response.ok && !response.uncertain) {
        clearPending(id); setRound(null); setPhase('idle'); setError(response.error);
      } else {
        setPhase('recovering'); setError('Your result is not confirmed yet. Check this flip before starting another.');
      }
    } catch { setPhase('recovering'); setError('Connection interrupted. Your result is unknown. Check this flip again.'); }
    finally { busy.current = false; }
  }
  const card = ['confirm', 'armed', 'submitting', 'recovering', 'result'].includes(phase) && round ? round.card :
    selectedCard ? { name: selectedCard.card.name, image: selectedCard.card.slabImage || selectedCard.card.image } : null;

  return <>
    <Link href="/vault" className="inline-flex min-h-11 items-center gap-2 text-sm text-neutral-400 hover:text-white"><ArrowLeft size={16} aria-hidden />Vault</Link>
    <div className="mt-3 flex items-end justify-between gap-4">
      <div><h1 className="font-display text-3xl font-black tracking-tight">One card. One flip.</h1>
        <p className="mt-2 max-w-lg text-sm text-neutral-400">Win its market value in Credit and keep your card. Lose, and the card leaves your Vault.</p></div>
      <span className="hidden shrink-0 rounded-full border border-white/15 px-3 py-2 text-xs text-neutral-400 sm:block">Black titanium</span>
    </div>
    <div className="mt-7 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-4 text-xs text-neutral-400">
        <span>Published win odds <strong className="ml-1 text-sm font-semibold text-white">{(locked || phase === 'result') && round ? round.published_win_percent : config?.published_win_percent ?? '—'}%</strong></span>
        <span>Emblem wins</span>
      </div>
      <div className="flex min-h-72 items-center justify-center bg-neutral-950 py-10 sm:min-h-80"><StaticCoin won={round?.status !== 'lost'} /></div>
      <div className="border-t border-white/10 p-5 sm:p-6">
        {phase === 'result' && round ? <div ref={resultPanel} tabIndex={-1} className="outline-none" role="status">
          <p className="text-sm text-neutral-400">{round.status === 'won' ? 'Emblem · You won' : 'Wordmark · Flip lost'}</p>
          <h2 className={`mt-1 font-display text-3xl font-black ${round.status === 'won' ? 'text-buyback-fg' : 'text-white'}`}>{round.status === 'won' ? `+${rm(round.win_amount)}` : 'Card forfeited'}</h2>
          <p className="mt-2 text-sm text-neutral-300">{round.status === 'won' ? 'Added to your withdrawable Credit. Your card stays in your Vault.' : `${round.card.name} has left your Vault. No Credit was added.`}</p>
          <div className="mt-5 flex flex-wrap gap-3"><Pill onClick={() => { setPhase('idle'); setRound(null); setError(''); }}>Choose a card</Pill>
            <Link href="/transactions" className={pillVariants({ variant: 'secondary' })}>View wallet<ArrowUpRight size={16} aria-hidden /></Link></div>
        </div> : phase === 'recovering' ? <div aria-live="polite">
          <h2 className="font-display text-xl font-bold">Resolve your previous flip</h2>
          <p className="mt-2 text-sm text-neutral-300">No new card can be committed while this result is uncertain.</p>
          <div className="mt-4 flex flex-wrap gap-3"><Pill onClick={() => pendingId && void recover(pendingId)}>Check result</Pill>
            {round?.status === 'quoted' && <Pill variant="secondary" onClick={() => void flip(true)}>Retry same flip</Pill>}</div>
        </div> : phase === 'armed' ? <div aria-live="polite">
          <h2 className="font-display text-xl font-bold">{live ? 'Ready when you are.' : 'Quote expired'}</h2>
          <p className="mt-2 text-sm text-neutral-400">{live ? 'Flip the coin to commit your card.' : 'Review your card again for a fresh value and odds.'}</p>
          <div className="mt-5 flex gap-3"><Pill disabled={!live} onClick={() => void flip()}>Flip coin</Pill><Pill variant="secondary" onClick={() => setPhase('idle')}>{live ? 'Cancel' : 'Review again'}</Pill></div>
        </div> : ['submitting', 'loading'].includes(phase) ? <p role="status" className="py-4 text-sm text-neutral-300">{phase === 'loading' ? 'Checking previous flips…' : 'Confirming your flip…'}</p> : <>
          <label htmlFor="flip-card" className="block text-sm font-semibold">Card from your Vault</label>
          <select id="flip-card" value={selected} disabled={locked || !items.length} onChange={event => setSelected(event.target.value)} className="mt-3 min-h-12 w-full rounded-xl border border-white/15 bg-neutral-800 px-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-white/50">
            <option value="">Select one card</option>{items.map(item => <option key={item.pullId} value={item.pullId}>{item.card.name}{item.card.priceMyr != null ? ` · ${rm(item.card.priceMyr)}` : ''}</option>)}
          </select>
          {items.length === 0 && <p className="mt-3 text-sm text-neutral-400">You need an unlocked card in your Vault to flip.</p>}
          {config && !config.eligible && <p className="mt-3 text-sm text-neutral-300">{config.reason}</p>}
          {!settings.ok && <p role="alert" className="mt-3 text-sm text-red-300">{settings.error}</p>}
          <Pill className="mt-5 w-full" size="lg" disabled={!selectedCard || !config?.eligible || locked} onClick={() => void review()}>{phase === 'quoting' ? 'Getting quote…' : 'Review card & odds'}</Pill>
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
      </div>
    </div>
    {card && <div className="mt-5 flex items-center gap-4">
      {card.image && <Image src={card.image} alt="" width={56} height={78} className="h-20 w-14 object-contain" unoptimized />}
      <div><p className="text-sm font-semibold">{card.name}</p><p className="mt-1 text-xs text-neutral-400">{round && locked ? `Confirmed value ${rm(round.stake_amount)}` : 'One vaulted card per flip'}</p></div>
    </div>}
    <p className="mt-5 max-w-xl text-xs leading-relaxed text-neutral-400">Bonus and gift-funded cards are included. Winnings add no playthrough requirement. Standard account and withdrawal checks still apply.{config?.max_stake_amount != null ? ` Maximum card value ${rm(config.max_stake_amount)}.` : ''}</p>
    <CoinFlipHistory refresh={historyRevision} />
    {phase === 'confirm' && round && createPortal(<div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-4">
      <button aria-hidden tabIndex={-1} onClick={() => setPhase('idle')} className="glass-stage absolute inset-0 bg-black/60" />
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="flip-confirm-title" tabIndex={-1} className="glass-panel relative max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-white/15 p-6 pb-8 outline-none sm:max-w-md sm:rounded-2xl">
        <h2 id="flip-confirm-title" className="font-display text-2xl font-bold">Put this card on the line?</h2>
        <p className="mt-4 text-sm font-semibold">{round.card.name}</p><p className="mt-1 font-display text-3xl font-black">{rm(round.stake_amount)}</p>
        <dl className="mt-5 space-y-4 text-sm"><div><dt className="text-neutral-400">Win · Emblem</dt><dd className="mt-1">Keep your card + <strong className="text-buyback-fg">{rm(round.stake_amount)} withdrawable Credit</strong></dd></div>
          <div><dt className="text-neutral-400">Lose · Wordmark</dt><dd className="mt-1 text-red-300">Your card is permanently forfeited. No Credit.</dd></div>
          <div className="flex justify-between border-t border-white/10 pt-4"><dt className="text-neutral-400">Published win odds</dt><dd>{round.published_win_percent}%</dd></div></dl>
        <p className="mt-4 text-xs text-neutral-400">{live ? 'Quote valid for 60 seconds from issue. The flip commits when you flick or tap Flip coin.' : 'This quote expired. Close and review your card again.'}</p>
        <div className="mt-6 flex gap-3"><Pill variant="secondary" className="flex-1" onClick={() => setPhase('idle')}>Cancel</Pill><Pill className="flex-1" disabled={!live} onClick={() => setPhase('armed')}>Confirm card</Pill></div>
      </div>
    </div>, document.body)}
  </>;
}
