/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // AGRIFUR2 Semantic Colors
        'agr-green': '#22c55e',      // Healthy/Agriculture
        'agr-blue': '#3b82f6',       // Water
        'agr-cyan': '#06b6d4',       // Sensors
        'agr-purple': '#8b5cf6',     // Satellite/Investigation
        'agr-yellow': '#eab308',     // Weather
        'agr-orange': '#f97316',     // Warning
        'agr-red': '#ef4444',        // Severe Risk
        'agr-magenta': '#d946ef',    // AI
        'agr-earth': '#92400e',      // Soil/Terrain

        // AGRIFUR2 bright theme: the slate scale is inverted so the existing
        // dark-panel class vocabulary renders as a clean light UI.
        //  - bg-slate-900  → app page background (near-white)
        //  - bg-slate-800  → panel background (white)
        //  - bg-slate-700  → sub-panel / hover (light gray)
        //  - text-slate-200..400 → dark text shades readable on light bg
        slate: {
          50: '#020617',
          100: '#0f172a',
          200: '#1e293b',
          300: '#334155',
          400: '#475569',
          500: '#64748b',
          600: '#cbd5e1',
          700: '#e2e8f0',
          800: '#f1f5f9',
          900: '#f8fafc',
        },

        // Darken the lightest status text shades (used on translucent tinted
        // chips) so they stay readable on white panels.
        green:  { 300: '#15803d', 400: '#16a34a' },
        emerald:{ 300: '#047857', 400: '#059669' },
        sky:    { 300: '#0284c7' },
        blue:   { 300: '#2563eb', 400: '#2563eb' },
        cyan:   { 300: '#0891b2', 400: '#0891b2' },
        teal:   { 300: '#0f766e' },
        purple: { 300: '#6d28d9', 400: '#7c3aed' },
        violet: { 300: '#6d28d9', 400: '#7c3aed' },
        pink:   { 300: '#be185d' },
        fuchsia:{ 300: '#a21caf' },
        indigo: { 300: '#4338ca' },
        amber:  { 300: '#b45309', 400: '#b45309' },
        yellow: { 300: '#a16207', 400: '#ca8a04' },
        orange: { 300: '#c2410c', 400: '#ea580c' },
        rose:   { 200: '#be123c', 300: '#be123c', 400: '#e11d48' },
        red:    { 300: '#dc2626', 400: '#dc2626' },
        gray:   { 300: '#374151', 400: '#4b5563' },
      },
      fontFamily: {
        'sans': ['Inter', 'system-ui', 'sans-serif'],
        'mono': ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}