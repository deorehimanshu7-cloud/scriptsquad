import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/lib/state/auth';

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuthStore();

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-200">Settings</h1>
        <p className="text-slate-400 mt-1">Configure your AGRIFUR2 experience</p>
      </div>
      <div className="max-w-2xl space-y-6">
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-slate-200 mb-4">Account</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Email</span>
              <span className="text-sm text-slate-200">{user?.email || 'Not set'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">Name</span>
              <span className="text-sm text-slate-200">{user?.name || 'Not set'}</span>
            </div>
          </div>
        </div>
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-slate-200 mb-4">Language</h3>
          <div className="space-y-2">
            {[{ v: 'en', l: 'English' }, { v: 'hi', l: 'हिन्दी (Hindi)' }, { v: 'mr', l: 'मराठी (Marathi)' }].map(lang => (
              <label key={lang.v} className="flex items-center gap-3 p-3 bg-slate-700/50 rounded-lg cursor-pointer hover:bg-slate-700 transition-colors">
                <input type="radio" name="language" value={lang.v} checked={i18n.language === lang.v}
                  onChange={() => i18n.changeLanguage(lang.v)} className="text-blue-500" />
                <span className="text-sm text-slate-200">{lang.l}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
          <h3 className="text-lg font-semibold text-slate-200 mb-4">Notifications</h3>
          <div className="space-y-3">
            {[
              { label: 'Anomaly alerts', desc: 'Get notified when anomalies are detected', on: true },
              { label: 'Risk warnings', desc: 'Get notified about high-risk situations', on: true },
              { label: 'Satellite updates', desc: 'Get notified when new satellite imagery is available', on: false },
              { label: 'Investigation updates', desc: 'Get notified about investigation progress', on: true },
            ].map(item => (
              <label key={item.label} className="flex items-center justify-between p-3 bg-slate-700/50 rounded-lg cursor-pointer">
                <div><div className="text-sm text-slate-200">{item.label}</div><div className="text-xs text-slate-400">{item.desc}</div></div>
                <input type="checkbox" defaultChecked={item.on} className="rounded" />
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
