/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Sistema interno (Tools/pendientes) — papel + vermellón
        paper:    "#f7f2e8",
        paperalt: "#efe7d3",
        edge:     "#e0d6bd",
        ink:      "#2a2620",
        muted:    "#8a7f68",
        dim:      "#6b624f",
        accent:   "#c5443a",
        ok:       "#5a8556",
        warn:     "#d4a017",
        fail:     "#c5443a",
        off:      "#cbc1a8",
      },
      fontFamily: {
        serif: ['"Fraunces"', "ui-serif", "Georgia", "serif"],
        sans:  ["ui-sans-serif", "system-ui", "sans-serif"],
        mono:  ["ui-monospace", "SF Mono", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
