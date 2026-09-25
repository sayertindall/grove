# Attribution

Everything in this directory is derived from **Beautiful UI** — "crafted, copy-paste
interface primitives for AI-native products" — by Shane Levine.

- Upstream: https://github.com/slev12397/beautiful-ui
- Vendored into this repository at `beautiful-ui/` for the port and then ported here.

## What changed in the port

The components are otherwise faithful copies, including prop names and export names, so diffs
against upstream stay readable. The following substitutions were required to run inside
Grove's Vite/React 19/Tailwind 4 app without adding dependencies:

| Upstream dependency | Replacement here |
| --- | --- |
| `@central-icons-react` (commercial icon set, used by `SidebarNav`) | `lucide-react` (already a Grove dependency) |
| `iconoir-react` (used by `SelectionActions`) | `lucide-react` |
| `glimm` (canvas sweep effect in `PromptBar`) | inlined canvas-2D sweep, same trigger and ref, honours `prefers-reduced-motion` |
| `liveline` (sparkline in `InsightCards`) | inlined SVG line chart with the same prop surface; static snapshots are faithful, live streaming and momentum are inert |
| `shadow-plugin` (CSS shadow scale) | inlined layered `oklch` shadow stacks in `src/index.css` |
| `@web-kits/audio` | not ported; only used by the upstream demo site |

Design tokens were merged additively into `src/index.css`; Grove's existing token values are not
overridden and Tailwind is not re-imported.

## License

MIT License

Copyright (c) 2026 Shane Levine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
