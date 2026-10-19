/** Marks a pull by a house-run account (the admin Automation Accounts list) in
 *  the public feeds. Same chip shape as TierBadge, neutral so it never reads as
 *  a tier. */
export function HouseTag() {
  return (
    <span className="shrink-0 rounded-md border border-white/20 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide text-neutral-300">
      House
    </span>
  );
}
