// Org-wide display/brand settings: fetched once per session, applied as CSS
// variables + date-format default. Refresh after any Settings change.
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setOrgDateFormat } from './api';
import { useAuth } from './auth';

const OrgSettingsContext = createContext(null);

function applyBrand(settings) {
  const root = document.documentElement;
  const brand = settings?.brand_color || '#10b981';
  root.style.setProperty('--brand', brand);
  // Derive a darker hover shade by scaling RGB down ~18%.
  const m = /^#([0-9a-fA-F]{6})$/.exec(brand);
  if (m) {
    const n = parseInt(m[1], 16);
    const d = (c) => Math.max(0, Math.round(c * 0.82));
    root.style.setProperty(
      '--brand-dark',
      '#' + [d(n >> 16), d((n >> 8) & 255), d(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('')
    );
  } else {
    root.style.setProperty('--brand-dark', '#059669');
  }
}

export function OrgSettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.orgProfile();
      setSettings(s);
      applyBrand(s);
      setOrgDateFormat(s.date_format || 'MM/DD/YYYY');
    } catch {
      /* keep defaults */
    }
  }, []);

  useEffect(() => {
    if (user) refresh();
    else {
      setSettings(null);
      applyBrand(null);
      setOrgDateFormat('MM/DD/YYYY');
    }
  }, [user, refresh]);

  return (
    <OrgSettingsContext.Provider value={{ settings, refresh }}>
      {children}
    </OrgSettingsContext.Provider>
  );
}

export function useOrgSettings() {
  return useContext(OrgSettingsContext);
}
