import React, { useState, useEffect } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/lib/state/auth';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

const navigation = [
  { name: 'nav.world', href: '/world', icon: '🌍' },
  { name: 'nav.intelligence', href: '/intelligence', icon: '🧠' },
  { name: 'nav.evidence', href: '/evidence', icon: '📊' },
  { name: 'nav.investigations', href: '/investigations', icon: '🔍' },
  { name: 'nav.satellite', href: '/satellite', icon: '🛰️' },
  { name: 'nav.sensors', href: '/sensors', icon: '📡' },
  { name: 'nav.weather', href: '/weather', icon: '🌦️' },
  { name: 'nav.environment', href: '/environment', icon: '🧪' },
  { name: 'nav.digital-twin', href: '/digital-twin', icon: '🎯' },
  { name: 'nav.history', href: '/history', icon: '📈' },
  { name: 'nav.simulation', href: '/simulation', icon: '⚡' },
  { name: 'nav.assistant', href: '/assistant', icon: '🤖' },
];

const secondaryNav = [
  { name: 'nav.settings', href: '/settings', icon: '⚙️' },
  { name: 'nav.system', href: '/system/providers', icon: '🔧' },
];

export default function AppShell() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { currentField, fields, setFields, setCurrentField } = useFieldStore();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  // truthful API status — never a hardcoded “Connected”
  useEffect(() => {
    const ping = async () => {
      try {
        const r = await fetch('/api/health', { method: 'GET' });
        const j = await r.json().catch(() => null);
        setApiOnline(r.ok && j?.success === true);
      } catch { setApiOnline(false); }
    };
    ping();
    const id = setInterval(ping, 20000);
    return () => clearInterval(id);
  }, []);

  // Fetch fields from API on mount and sync with store
  useEffect(() => {
    const fetchFields = async () => {
      try {
        const response = await api.get<{ success: boolean; data: any[] }>('/fields');
        if (response.success && response.data) {
          setFields(response.data);
          // If currentField is stale or missing, set to first field
          if (response.data.length > 0) {
            const current = useFieldStore.getState().currentField;
            const valid = current && response.data.some((f: any) => f.id === current.id);
            if (!valid) {
              setCurrentField(response.data[0]);
            }
          }
        }
      } catch (e) {
        console.error('Failed to fetch fields:', e);
      }
    };
    fetchFields();
  }, []);

  const handleLanguageChange = (lang: string) => { i18n.changeLanguage(lang); };
  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="flex h-screen bg-slate-900">
      <div className={`${sidebarOpen ? 'w-64' : 'w-16'} bg-slate-800 border-r border-slate-700 flex flex-col transition-all duration-300`}>
        <div className="h-16 flex items-center justify-center border-b border-slate-700">
          {sidebarOpen ? (<div className="flex items-center gap-2"><span className="text-2xl">🌱</span><span className="text-xl font-bold text-slate-200">AGRIFUR2</span></div>) : (<span className="text-2xl">🌱</span>)}
        </div>
        <nav className="flex-1 py-4 overflow-y-auto">
          <div className="px-2 space-y-1">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href;
              return (<Link key={item.href} to={item.href} className={`${isActive ? 'bg-slate-700 text-slate-200' : 'text-slate-300 hover:bg-slate-700 hover:text-slate-200'} flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors`}><span className="text-lg">{item.icon}</span>{sidebarOpen && <span>{t(item.name)}</span>}</Link>);
            })}
          </div>
          <div className="px-2 mt-8 space-y-1">
            {secondaryNav.map((item) => {
              const isActive = location.pathname === item.href;
              return (<Link key={item.href} to={item.href} className={`${isActive ? 'bg-slate-700 text-slate-200' : 'text-slate-300 hover:bg-slate-700 hover:text-slate-200'} flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors`}><span className="text-lg">{item.icon}</span>{sidebarOpen && <span>{t(item.name)}</span>}</Link>);
            })}
          </div>
        </nav>
        <div className="p-4 border-t border-slate-700">
          {sidebarOpen ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-600 rounded-full flex items-center justify-center"><span className="text-sm font-medium text-slate-200">{user?.email?.charAt(0).toUpperCase() || 'U'}</span></div>
                <div className="text-sm"><p className="text-slate-200 font-medium truncate max-w-[120px]">{user?.email || 'User'}</p></div>
              </div>
              <button onClick={handleLogout} className="text-slate-400 hover:text-slate-200" title={t('auth.logout')}>🚪</button>
            </div>
          ) : (<button onClick={handleLogout} className="w-full flex justify-center text-slate-400 hover:text-slate-200" title={t('auth.logout')}>🚪</button>)}
        </div>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-slate-400 hover:text-slate-200">{sidebarOpen ? '◀' : '▶'}</button>
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-sm">Field:</span>
              <select value={currentField?.id || ''} onChange={(e) => { const field = fields.find((f) => f.id === e.target.value); setCurrentField(field || null); }} className="bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 border border-slate-600 focus:outline-none focus:border-blue-500">
                <option value="">Select Field</option>
                {fields.map((field) => (<option key={field.id} value={field.id}>{field.name}</option>))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <select value={i18n.language} onChange={(e) => handleLanguageChange(e.target.value)} className="bg-slate-700 text-slate-200 text-sm rounded px-3 py-1.5 border border-slate-600 focus:outline-none focus:border-blue-500">
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
              <option value="mr">मराठी</option>
            </select>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${apiOnline === false ? 'bg-rose-500' : apiOnline === true ? 'bg-emerald-500' : 'bg-slate-500'}`}></div>
              <span className="text-xs text-slate-400">{apiOnline === false ? 'API offline' : apiOnline === true ? 'API online' : '…'}</span>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-auto"><Outlet /></main>
      </div>
    </div>
  );
}
