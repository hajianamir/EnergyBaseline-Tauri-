import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const resources = {
  en: {
    translation: {
      app: {
        name: 'EnergyBaseline',
        subtitle: 'M&V & Time-Series Baseline Platform',
      },
      nav: {
        dataSetup: '1. Data & Columns',
        vsg: '2. Variable Gate (VSG)',
        tcp: '3. Test Policy (TCP)',
        diagnostics: '4. Diagnostics & EDA',
        modeling: '5. Modeling & Top-5',
        monitoring: '6. Prediction & Drift',
        report: '7. Report & Audit',
        status: '8. System & Storage',
      },
      common: {
        auto: 'AUTO',
        userOverride: 'USER_OVERRIDE',
        preRegistered: 'pre_registered',
        postHoc: 'post_hoc',
        lockBaseline: 'Lock Baseline',
        locked: 'Locked',
      },
    },
  },
};

i18n.use(initReactI18next).init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
