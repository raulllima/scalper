import type { Config } from "tailwindcss";

export default {
  content: ["./src/renderer/**/*.{vue,ts}"],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
