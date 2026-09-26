# Attribution

Everything in this directory is derived from **Beautiful UI** — "crafted, copy-paste
interface primitives for AI-native products" — by Shane Levine.

- Upstream: https://github.com/slev12397/beautiful-ui
- Vendored into this repository at `beautiful-ui/` for the port and then ported here.

## What changed in the port

Only the primitives the chat renders are vendored, and they are **styles, not behaviour**: each
one renders exactly the props it is given — no seeded demo content, no self-driven animation or
timers, and no vendor copy. Prop and export names are kept so diffs against upstream stay
readable.

Substitutions required to run inside Grove's Vite/React 19/Tailwind 4 app without adding
dependencies:

| Upstream dependency | Replacement here |
| --- | --- |
| `glimm` (canvas sweep effect in `PromptBar`) | inlined canvas-2D sweep, same trigger and ref, honours `prefers-reduced-motion` |
| `shadow-plugin` (CSS shadow scale) | inlined layered `oklch` shadow stacks in `src/index.css` |
| `@web-kits/audio` | not ported; only used by the upstream demo site |

Components the app does not render are not vendored, along with their demo-only dependencies
(`@central-icons-react` for `SidebarNav`, `iconoir-react` for `SelectionActions`, `liveline` for
`InsightCards`).

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
