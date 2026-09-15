/**
 * Tailwind, wired so that **no colour is ever written here**.
 *
 * Every colour in this build is a CSS custom property declared in
 * `src/tokens.css`. The palette below only names them, which is what makes the
 * three-state theme (light / dark / system) a property of one file rather than
 * of every component. Utilities with an opacity modifier are deliberately not
 * supported: a token is a decision, not a starting point to fade.
 */
/** @type {import('tailwindcss').Config} */
export default {
  // Preflight is off: the nine monitoring pages predate Tailwind and are styled
  // by hand in `styles.css`. Resetting the document out from under them would
  // be a redesign nobody asked for, so utilities are added, nothing is taken.
  corePlugins: { preflight: false },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', ':root[data-theme="dark"] &'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        raised: 'var(--surface-raised)',
        sunken: 'var(--surface-sunken)',
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        text: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-faint)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-contrast': 'var(--accent-contrast)',
        good: 'var(--good)',
        'good-soft': 'var(--good-soft)',
        warning: 'var(--warning)',
        'warning-soft': 'var(--warning-soft)',
        critical: 'var(--critical)',
        'critical-soft': 'var(--critical-soft)',
        overlay: 'var(--overlay)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        panel: 'var(--shadow-panel)',
        pop: 'var(--shadow-pop)',
      },
    },
  },
  plugins: [],
};
