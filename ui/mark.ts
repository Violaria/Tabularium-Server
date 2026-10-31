// The Tabularium mark and the browser tab's icon. No side effects, so the share viewer can use it without the
// application's theme handling.
/** The Tabularium mark: the arcade of the Roman record office, drawn in `fill` (the current colour when not given). */
export const markShapes = (fill = 'currentColor') => `<g fill="${fill}"><rect x="10" y="12" width="44" height="7" rx="1.5"/>`
  + '<path fill-rule="evenodd" d="M12 22h40v24H12zM16 46V31a4 4 0 0 1 8 0v15zM28 46V31a4 4 0 0 1 8 0v15zM40 46V31a4 4 0 0 1 8 0v15z"/>'
  + '<rect x="8" y="48" width="48" height="5" rx="1.5"/></g>';
/** The browser tab's icon in the colours of the theme in use, as the mark in the sidebar shows them. */
export function paintIcon() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--mark-bg);background-color:var(--mark-text)';
  document.documentElement.append(probe);
  const { color: background, backgroundColor: foreground } = getComputedStyle(probe);
  probe.remove();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/>${markShapes(foreground)}</svg>`;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
