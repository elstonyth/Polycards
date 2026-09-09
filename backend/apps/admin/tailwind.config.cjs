/** @type {import('tailwindcss').Config} */
// Tailwind config for the standalone Mercur admin SPA. MUST stay `.cjs`: this
// package is `type: module`, but Tailwind v3's config loader uses CommonJS require().
//
// `@mercurjs/admin/index.css` USED to ship source `@tailwind` directives, so
// this config existed to compile the dashboard's own utility layer (incl. the
// `lg:` variants that drive the desktop sidebar). Since @mercurjs/admin 2.3.1
// that file is precompiled, and the directives this config expands live in
// src/admin-ui.css (see the note there) — for OUR routes' classes. The `content`
// globs keep the dashboard/admin dist so a class shared with the dashboard is
// never purged from our layer either.
module.exports = {
  presets: [require("@medusajs/ui-preset")],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@medusajs/dashboard/dist/**/*.{js,mjs}",
    "./node_modules/@mercurjs/admin/dist/**/*.{js,mjs}",
  ],
};
