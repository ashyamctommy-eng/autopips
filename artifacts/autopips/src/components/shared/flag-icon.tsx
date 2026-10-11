import * as React from 'react';

/**
 * INLINE CIRCULAR FLAG ICONS.
 *
 * Self-contained SVG — no emoji (they render as letter pairs on Windows Chrome)
 * and no network request per row (a flag CDN would leak every quote the user
 * watches). Each flag is a SIMPLIFIED geometric rendition, recognisable at 28px;
 * it is a UI mark, not a heraldic reproduction.
 *
 * A currency with no bespoke flag falls back to a neutral disc carrying its own
 * three-letter code, so an unknown pair is still legible rather than blank.
 */

interface FlagIconProps {
  /** ISO-4217 code, e.g. `USD`. Case-insensitive. */
  code: string;
  /** Rendered size in px. Default 28. */
  size?: number;
  className?: string;
}

type Nodes = React.ReactNode;

function bands(colors: string[], dir: 'h' | 'v'): Nodes {
  const step = 32 / colors.length;
  return colors.map((fill, index) => (
    <rect
      key={`${fill}-${index}`}
      x={dir === 'v' ? index * step : 0}
      y={dir === 'h' ? index * step : 0}
      width={dir === 'v' ? step : 32}
      height={dir === 'h' ? step : 32}
      fill={fill}
    />
  ));
}

/** Nordic offset cross (Sweden, Norway, Denmark). */
function nordic(field: string, cross: string, inner?: string): Nodes {
  return (
    <>
      <rect width="32" height="32" fill={field} />
      <rect x="9" y="0" width="6" height="32" fill={cross} />
      <rect x="0" y="13" width="32" height="6" fill={cross} />
      {inner ? (
        <>
          <rect x="10.5" y="0" width="3" height="32" fill={inner} />
          <rect x="0" y="14.5" width="32" height="3" fill={inner} />
        </>
      ) : null}
    </>
  );
}

/** Simplified Union Jack, drawn into the top-left canton when `canton` is set. */
function unionJack(canton = false): Nodes {
  const box = canton ? { w: 16, h: 13 } : { w: 32, h: 32 };
  const sx = canton ? 0.5 : 1;
  const sy = canton ? 0.4 : 1;
  return (
    <g>
      <rect width={box.w} height={box.h} fill="#012169" />
      <path d={`M0 0 L${box.w} ${box.h} M${box.w} 0 L0 ${box.h}`} stroke="#fff" strokeWidth={5 * sy} />
      <path d={`M0 0 L${box.w} ${box.h} M${box.w} 0 L0 ${box.h}`} stroke="#C8102E" strokeWidth={2.5 * sy} />
      <rect x={box.w / 2 - 2.6 * sx} y="0" width={5.2 * sx} height={box.h} fill="#fff" />
      <rect x="0" y={box.h / 2 - 2.2 * sy} width={box.w} height={4.4 * sy} fill="#fff" />
      <rect x={box.w / 2 - 1.6 * sx} y="0" width={3.2 * sx} height={box.h} fill="#C8102E" />
      <rect x="0" y={box.h / 2 - 1.4 * sy} width={box.w} height={2.8 * sy} fill="#C8102E" />
    </g>
  );
}

function star(cx: number, cy: number, r: number, fill = '#fff', key?: string): Nodes {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = (Math.PI / 5) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.45;
    return `${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`;
  }).join(' ');
  return <polygon key={key} points={points} fill={fill} />;
}

function renderFlag(code: string): Nodes {
  switch (code) {
    case 'USD':
      return (
        <>
          {Array.from({ length: 13 }, (_, i) => (
            <rect key={i} x="0" y={(i * 32) / 13} width="32" height={32 / 13} fill={i % 2 === 0 ? '#B22234' : '#fff'} />
          ))}
          <rect width="15" height="17.2" fill="#3C3B6E" />
          {[3, 7.5, 12].map((y) => [3, 7.5, 12].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="0.7" fill="#fff" />))}
        </>
      );
    case 'EUR':
      return (
        <>
          <rect width="32" height="32" fill="#003399" />
          {Array.from({ length: 8 }, (_, i) => {
            const a = (Math.PI / 4) * i - Math.PI / 2;
            return <circle key={i} cx={16 + 9 * Math.cos(a)} cy={16 + 9 * Math.sin(a)} r="1.5" fill="#FFCC00" />;
          })}
        </>
      );
    case 'GBP':
      return unionJack(false);
    case 'JPY':
      return (
        <>
          <rect width="32" height="32" fill="#fff" />
          <circle cx="16" cy="16" r="8.5" fill="#BC002D" />
        </>
      );
    case 'AUD':
      return (
        <>
          <rect width="32" height="32" fill="#012169" />
          {unionJack(true)}
          {star(24, 9, 2.6, '#fff', 'a1')}
          {star(8, 24, 3, '#fff', 'a2')}
          {star(24, 24, 2.4, '#fff', 'a3')}
          {star(17, 25, 2, '#fff', 'a4')}
        </>
      );
    case 'NZD':
      return (
        <>
          <rect width="32" height="32" fill="#012169" />
          {unionJack(true)}
          {star(25, 9, 2.4, '#fff', 'n1')}
          {star(20, 24, 2, '#fff', 'n2')}
          {star(26, 18, 2, '#fff', 'n3')}
        </>
      );
    case 'CAD':
      return (
        <>
          <rect width="32" height="32" fill="#fff" />
          <rect width="8" height="32" fill="#D80621" />
          <rect x="24" width="8" height="32" fill="#D80621" />
          <path d="M16 7 L18.4 13 L21 12 L19.6 16.5 L22 17.5 L16 22 L10 17.5 L12.4 16.5 L11 12 L13.6 13 Z" fill="#D80621" />
        </>
      );
    case 'CHF':
      return (
        <>
          <rect width="32" height="32" fill="#D52B1E" />
          <rect x="13" y="6.5" width="6" height="19" fill="#fff" />
          <rect x="6.5" y="13" width="19" height="6" fill="#fff" />
        </>
      );
    case 'MXN':
      return (
        <>
          {bands(['#006847', '#fff', '#CE1126'], 'v')}
          <circle cx="16" cy="16" r="3" fill="#8B5A2B" />
        </>
      );
    case 'PLN':
      return bands(['#fff', '#DC143C'], 'h');
    case 'CZK':
      return (
        <>
          {bands(['#fff', '#D7141A'], 'h')}
          <path d="M0 0 L14 16 L0 32 Z" fill="#11457E" />
        </>
      );
    case 'HUF':
      return bands(['#CE2939', '#fff', '#477050'], 'h');
    case 'ZAR':
      return (
        <>
          <rect width="32" height="32" fill="#007A4D" />
          <path d="M0 0 L14 16 L0 32 Z" fill="#000" />
          <path d="M0 4 L11 16 L0 28 Z" fill="#FFB612" />
          <rect x="0" y="14.5" width="32" height="3" fill="#fff" />
          <rect x="0" y="18" width="32" height="3" fill="#DE3831" />
          <rect x="0" y="11" width="32" height="3" fill="#fff" />
          <rect x="0" y="21" width="32" height="3" fill="#002395" />
        </>
      );
    case 'SEK':
      return nordic('#006AA7', '#FECC02');
    case 'NOK':
      return nordic('#BA0C2F', '#fff', '#00205B');
    case 'DKK':
      return nordic('#C8102E', '#fff');
    case 'TRY':
      return (
        <>
          <rect width="32" height="32" fill="#E30A17" />
          <circle cx="14" cy="16" r="7" fill="#fff" />
          <circle cx="16.5" cy="16" r="5.6" fill="#E30A17" />
          {star(23, 16, 3, '#fff', 't1')}
        </>
      );
    case 'SGD':
      return (
        <>
          {bands(['#ED2939', '#fff'], 'h')}
          <circle cx="10" cy="8" r="4.2" fill="#fff" />
          <circle cx="12.2" cy="8" r="3.6" fill="#ED2939" />
          {[15, 18.5, 22].map((x, i) => <circle key={i} cx={x} cy={i === 1 ? 6 : 8.5} r="0.9" fill="#fff" />)}
        </>
      );
    case 'HKD':
      return (
        <>
          <rect width="32" height="32" fill="#DE2910" />
          {Array.from({ length: 5 }, (_, i) => {
            const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
            return <circle key={i} cx={16 + 5 * Math.cos(a)} cy={16 + 5 * Math.sin(a)} r="2.6" fill="#fff" />;
          })}
          <circle cx="16" cy="16" r="2" fill="#DE2910" />
        </>
      );
    case 'CNH':
      return (
        <>
          <rect width="32" height="32" fill="#DE2910" />
          {star(11, 11, 5, '#FFDE00', 'c0')}
          {star(19, 4.5, 1.8, '#FFDE00', 'c1')}
          {star(22, 8.5, 1.8, '#FFDE00', 'c2')}
          {star(22, 13, 1.8, '#FFDE00', 'c3')}
          {star(19, 16.5, 1.8, '#FFDE00', 'c4')}
        </>
      );
    case 'INR':
      return (
        <>
          {bands(['#FF9933', '#fff', '#138808'], 'h')}
          <circle cx="16" cy="16" r="4.2" fill="none" stroke="#000080" strokeWidth="1.2" />
          <circle cx="16" cy="16" r="1" fill="#000080" />
        </>
      );
    default:
      return (
        <>
          <rect width="32" height="32" fill="#26313a" />
          <text x="16" y="20.5" textAnchor="middle" fontSize="11" fontWeight="700" fill="#cbd5e1">
            {code}
          </text>
        </>
      );
  }
}

const KNOWN = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF', 'MXN', 'PLN',
  'CZK', 'HUF', 'ZAR', 'SEK', 'NOK', 'DKK', 'TRY', 'SGD', 'HKD', 'CNH', 'INR',
]);

export function FlagIcon({ code, size = 28, className }: FlagIconProps) {
  const normalised = (code ?? '').trim().toUpperCase();
  const clipId = React.useId().replace(/:/g, '');
  const known = KNOWN.has(normalised);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={known ? `${normalised} flag` : `${normalised} currency`}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="16" cy="16" r="16" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {known ? renderFlag(normalised) : renderFlag('')}
      </g>
      <circle cx="16" cy="16" r="15.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
    </svg>
  );
}

/** True when a bespoke flag exists (used to decide icon shape). */
export function hasFlag(code: string): boolean {
  return KNOWN.has((code ?? '').trim().toUpperCase());
}

export default FlagIcon;
