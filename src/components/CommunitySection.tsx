import { cn } from '@/lib/utils';
import { Heart } from 'lucide-react';

type CommunityPost = {
  link: string;
  img: string;
  text: string;
  name: string;
  avatar: string;
};

// Real posts extracted from phygitals.com "Our Community" marquee (8 unique cards,
// duplicated once in the track for a seamless infinite loop).
const POSTS: CommunityPost[] = [
  {
    link: 'https://x.com/pominik/status/1960039317956620617',
    img: '/social/tweets/1960039317956620617_media-1.webp',
    text: 'I got this from a RM 25 pack\nAMA',
    name: 'pominik',
    avatar: '/social/pfp/pominik-400x400.jpg',
  },
  {
    link: 'https://x.com/PleiadesHawkin/status/1959021922383274245',
    img: '/social/tweets/1959021922383274245_media-1.webp',
    text: 'Mail day here in the gallery 📬\n\n@phygitals made it REAL!! 🤝',
    name: 'James Pleiades Hawkins',
    avatar: '/social/pfp/PleiadesHawkin-400x400.jpg',
  },
  {
    link: 'https://twitter.com/dcfgod/status/1953653730555179251',
    img: '/social/tweets/1953653730555179251_media-1.webp',
    text: 'Phygitals is so much more fun than collecting as it has the ease of trading / buying on chain… but real demand off chain and can always redeem the actual card\n\nIf you’re looking to collect Pokémons this is the team to reach out to. Don’t think what’s on their site is all they got - they’re directly linked to a bunch of marketplaces and just white glove acquired what I wanted',
    name: 'DCF GOD',
    avatar: '/social/pfp/dcfgod-400x400.jpg',
  },
  {
    link: 'https://x.com/CaleCrypto/status/1951018112519712830',
    img: '/social/tweets/1951018112519712830_media-1.webp',
    text: 'Slab delivery day',
    name: 'Cale',
    avatar: '/social/pfp/CaleCrypto-400x400.jpg',
  },
  {
    link: 'https://x.com/LebnaniTCG/status/1947359768730910937',
    img: '/social/tweets/1947359768730910937_media-1.webp',
    text: 'Thank you @phygitals',
    name: 'Lebnani TCG',
    avatar: '/social/pfp/LebnaniTCG-400x400.jpg',
  },
  {
    link: 'https://x.com/Mikerow01/status/1940199479699022263',
    img: '/social/tweets/1940199479699022263_media-1.webp',
    text: 'LFG my claim from @phygitals came it look how nice those slabs are\nthank you again one love',
    name: 'Mikerow',
    avatar: '/social/pfp/Mikerow01-400x400.jpg',
  },
  {
    link: 'https://x.com/ClmentHiggins/status/1937523748019527828',
    img: '/social/tweets/1937523748019527828_media-1.webp',
    text: 'From Digital to Physical ✈️\n\nI just received my first five @phygitals cards!\n\nPurchased or won on the platform using the Claw and the Lucky Draw, and delivered to my home in just a few days\n\nYou guys are doing an amazing job!\n\nphygitals.com/invite/662b59',
    name: 'Brice',
    avatar: '/social/pfp/ClmentHiggins-400x400.jpg',
  },
  {
    link: 'https://x.com/_LYNCHY__/status/1937209444800004323',
    img: '/social/tweets/1937209444800004323_media-1.webp',
    text: 'Digital to physical in just under 2 weeks super cool!\n\nThanks @phygitals for creating unique way to trade!',
    name: 'Lynch',
    avatar: '/social/pfp/_LYNCHY__-400x400.jpg',
  },
];

function CommunityCard({ post }: { post: CommunityPost }) {
  return (
    <a
      href={post.link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'group/card flex w-[280px] flex-shrink-0 flex-col overflow-hidden rounded-2xl border bg-white/5 transition-[border-color] duration-300 sm:w-[320px]',
        'border-white/10 shadow-[0_4px_20px_rgba(0,0,0,0.25)] hover:border-white/20',
      )}
    >
      <div className="relative h-[200px] w-full overflow-hidden bg-white/5 sm:h-[220px]">
        {/* eslint-disable-next-line @next/next/no-img-element -- external community-post image (arbitrary host), kept raw like the hero art */}
        <img
          src={post.img}
          alt=""
          width={320}
          height={220}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover transition-transform duration-500 group-hover/card:scale-105"
        />
      </div>
      <div className="flex flex-1 flex-col p-4">
        <p className="line-clamp-3 flex-1 whitespace-pre-line text-[13px] leading-relaxed text-neutral-300">
          {post.text}
        </p>
        <div className="mt-3 flex items-center gap-2.5 border-t border-white/5 pt-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- external avatar (arbitrary host), kept raw like the hero art */}
          <img
            src={post.avatar}
            alt={post.name}
            width={28}
            height={28}
            loading="lazy"
            className="h-7 w-7 rounded-full object-cover"
          />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-white">
              {post.name}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1 text-[11px] text-neutral-400">
            <Heart className="h-3.5 w-3.5" aria-hidden />
          </div>
        </div>
      </div>
    </a>
  );
}

export default function CommunitySection() {
  // Duplicate the posts so the marquee track loops seamlessly.
  const track = [...POSTS, ...POSTS];

  return (
    <div className="mt-10 sm:mt-14">
      {/* Scoped marquee keyframes + scrollbar hiding (self-contained). */}
      <style>{`
        @keyframes sp-scroll-x {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(-50%, 0, 0); }
        }
        .sp-community-scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
        .sp-community-scrollbar-hide::-webkit-scrollbar { display: none; }
        @media (prefers-reduced-motion: reduce) {
          .sp-community-track { animation: none !important; }
        }
      `}</style>

      <div className="mb-4 text-center sm:mb-5">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.3em] text-white/50">
          100,000+ collectors
        </p>
        <h2 className="font-heading bg-gradient-to-b from-white via-white/80 to-white/30 bg-clip-text text-2xl font-bold tracking-tight text-transparent md:text-3xl">
          Our Community
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-[14px] text-neutral-400">
          Join the largest collectibles community and see what people are
          pulling.
        </p>
      </div>

      <div className="relative">
        {/* Edge fade masks */}
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-neutral-900 to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-neutral-900 to-transparent" />

        <div className="sp-community-scrollbar-hide group/scroll -my-4 overflow-hidden py-4">
          <div
            className="sp-community-track flex w-max gap-3 [transform:translateZ(0)] will-change-transform group-hover/scroll:[animation-play-state:paused]"
            style={{ animation: 'sp-scroll-x 90s linear infinite' }}
          >
            {track.map((post, i) => (
              <CommunityCard key={`${post.link}-${i}`} post={post} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
