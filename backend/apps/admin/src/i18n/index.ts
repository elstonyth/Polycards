import en from './en.json';
import zhCN from './zhCN.json';

// Keys MUST match the core dashboard's language codes: the dashboard deep-merges
// each entry into its own locale of the same key. zhCN only carries the Stats
// page; every other custom string falls back to en (the dashboard's fallbackLng).
const i18nResources = {
  en: {
    translation: en,
  },
  zhCN: {
    translation: zhCN,
  },
};

export default i18nResources;
