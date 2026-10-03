import type { Metadata } from './types';

const DEFAULT_TITLE = 'Autopipsz — Automated Trading Infrastructure';
const TEMPLATE = '%s · Autopipsz';

function setMeta(name: string, content: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (content === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/** Page metadata wins over layout metadata; the root template applies. */
export function applyMetadata(...metas: Array<Metadata | undefined>): void {
  const found = metas.filter(Boolean) as Metadata[];
  const titleSrc = found.map((m) => m.title).find((t) => t !== undefined);
  let title = DEFAULT_TITLE;
  if (typeof titleSrc === 'string') title = TEMPLATE.replace('%s', titleSrc);
  else if (titleSrc?.absolute) title = titleSrc.absolute;
  document.title = title;
  const desc = found.map((m) => m.description).find((d) => d !== undefined);
  if (desc) setMeta('description', desc);
  const robots = found.map((m) => m.robots).find((r) => r !== undefined);
  if (typeof robots === 'object' && robots) {
    setMeta('robots', `${robots.index === false ? 'noindex' : 'index'}, ${robots.follow === false ? 'nofollow' : 'follow'}`);
  } else {
    setMeta('robots', 'index, follow');
  }
}
