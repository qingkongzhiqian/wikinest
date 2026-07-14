import { createTranslator, normalizeLocale } from '../src/i18n.js';

export function readLocale(store) {
  return normalizeLocale(store.get('locale'));
}

export function writeLocale(store, value) {
  const locale = normalizeLocale(value);
  store.set('locale', locale);
  return locale;
}

export function syncLocaleToEnv(value) {
  process.env.WIKINEST_LOCALE = normalizeLocale(value);
}

export function desktopLabels(locale) {
  const t = createTranslator(locale);
  return {
    file: t('desktop.file'),
    edit: t('desktop.edit'),
    view: t('desktop.view'),
    settings: t('desktop.settings'),
    settingsTitle: t('app.settings'),
    openFolder: t('desktop.openFolder'),
    openRecent: t('desktop.openRecent'),
    clearRecent: t('desktop.clearRecent'),
    noRecent: t('desktop.noRecent'),
    openVaultTitle: t('desktop.openVaultTitle'),
    chooseVaultTitle: t('desktop.chooseVaultTitle'),
  };
}
