/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts,js}'],
  theme: {
    extend: {
      colors: {
        bg: '#09090f',
        surface: '#111118',
        border: '#1e1e2a',
        accent: '#f59e0b',
        'accent-dim': '#b45309',
        active: '#22c55e',
        muted: '#4b5563',
        danger: '#ef4444',
        'text-primary': '#f1f5f9',
        'text-muted': '#94a3b8',
      },
      fontFamily: {
        sans: ['"DM Sans"', 'sans-serif'],
        mono: ['"Space Mono"', 'monospace'],
      },
      animation: {
        pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
