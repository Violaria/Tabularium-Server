// The entrance page: links to the web entrances, in the chosen language.
import { languageSelect, t } from './i18n.js';

function render() {
  document.title = 'Tabularium';
  const home = document.getElementById('home')!;
  home.innerHTML = `<div class="brand"><span class="brand-mark">T</span><div><strong>Tabularium</strong><small>${t('home.subtitle')}</small></div></div>
    <a class="card entry" href="/admin/"><h2>${t('home.console')}</h2><p>${t('home.consoleDesc')}</p></a>
    <a class="card entry" href="/notes/"><h2>${t('home.notes')}</h2><p>${t('home.notesDesc')}</p></a>
    <a class="card entry" href="/tabularius/"><h2>${t('home.tabularius')}</h2><p>${t('home.tabulariusDesc')}</p></a>
    <small>${t('home.syncHint')}</small><div id="language"></div>`;
  document.getElementById('language')!.replaceChildren(languageSelect(render));
}
render();
