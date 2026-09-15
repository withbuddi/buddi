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
  // Preflight is ON. It has to be: without it nothing resets `border-width` to
  // zero, and the `border-style: solid` that Tailwind's border utilities assume
  // turns every element on the page into a 3px box — which is exactly what the
  // workbench shipped as. It also stops `input`, `button`, `select` and
  // `textarea` rendering with their user-agent chrome. The nine monitoring
  // pages predate Tailwind and did rely on the document's own defaults; what
  // they relied on is restored explicitly, scoped to `main`, in `styles.css`.
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', ':root[data-theme="dark"] &'],
  theme: {
    extend: {
      // Preflight paints its universal `border-color` from this, so the reset
      // itself spends a token rather than a literal.
      borderColor: { DEFAULT: 'var(--line)' },
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
