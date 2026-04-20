/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1020",
        card: "#111a33",
        stroke: "#22305e",
        text: "#e8eeff",
        muted: "#a8b3d8",
        accent: "#4f7cff",
        good: "#2bd576",
        bad: "#ff4d6d",
        warn: "#ffcc00"
      }
    }
  },
  plugins: []
};

