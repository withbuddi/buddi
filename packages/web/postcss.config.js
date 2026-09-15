/** Tailwind runs through PostCSS at build time; nothing here reaches the network. */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
