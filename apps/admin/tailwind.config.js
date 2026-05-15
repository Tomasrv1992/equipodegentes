/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces
        paper:        "oklch(0.965 0.012 85)",
        "paper-2":    "oklch(0.985 0.008 85)",
        "paper-sunken": "oklch(0.93 0.015 82)",
        edge:         "oklch(0.86 0.018 80)",
        "edge-2":     "oklch(0.92 0.012 80)",

        // Ink scale (warm)
        ink:    "oklch(0.18 0.012 60)",
        "ink-2": "oklch(0.32 0.010 60)",
        "ink-3": "oklch(0.50 0.010 65)",
        "ink-4": "oklch(0.65 0.012 75)",

        // Accent (vermellón Tomás)
        accent:        "oklch(0.55 0.18 28)",
        "accent-soft": "oklch(0.93 0.04 28)",

        // Status
        ok:        "oklch(0.58 0.13 145)",
        "ok-soft": "oklch(0.93 0.05 145)",
        warn:        "oklch(0.70 0.16 75)",
        "warn-soft": "oklch(0.95 0.07 75)",
        fail:        "oklch(0.58 0.21 25)",
        "fail-soft": "oklch(0.94 0.08 25)",

        // Terminal (logs / errores)
        "term-bg":     "oklch(0.18 0.008 60)",
        "term-fg":     "oklch(0.92 0.012 80)",
        "term-accent": "oklch(0.78 0.16 75)",

        // Legacy aliases (compat con código viejo durante refactor)
        paperalt: "oklch(0.93 0.015 82)",
        muted:    "oklch(0.50 0.010 65)",
        dim:      "oklch(0.32 0.010 60)",
        off:      "oklch(0.78 0.018 80)",
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "ui-sans-serif", "system-ui"],
        sans:    ['"General Sans"', '"Bricolage Grotesque"', "ui-sans-serif", "system-ui"],
        mono:    ['"JetBrains Mono"', "ui-monospace", "Consolas", "monospace"],
        serif:   ['"Bricolage Grotesque"', "ui-serif", "Georgia", "serif"],
      },
      letterSpacing: {
        tightest: "-0.04em",
        tighter:  "-0.025em",
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
