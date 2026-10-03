import * as React from 'react';
import { navigate } from 'wouter/use-browser-location';

type UrlObject = { pathname?: string; query?: Record<string, string | number | undefined>; hash?: string };

export interface LinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string | UrlObject;
  replace?: boolean;
  scroll?: boolean;
  prefetch?: boolean | null;
}

function toHref(href: string | UrlObject): string {
  if (typeof href === 'string') return href;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(href.query ?? {})) if (v !== undefined) q.set(k, String(v));
  const qs = q.toString();
  return `${href.pathname ?? ''}${qs ? `?${qs}` : ''}${href.hash ? `#${href.hash.replace(/^#/, '')}` : ''}`;
}

const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, replace, scroll, prefetch: _prefetch, onClick, target, ...rest },
  ref,
) {
  const resolved = toHref(href);
  return (
    <a
      {...rest}
      ref={ref}
      href={resolved}
      target={target}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (target && target !== '_self') return;
        if (rest.download !== undefined) return;
        if (!resolved.startsWith('/') || resolved.startsWith('//')) return;
        event.preventDefault();
        navigate(resolved, { replace });
        if (scroll !== false) window.scrollTo(0, 0);
      }}
    />
  );
});

export default Link;
