# React + TypeScript + Vite

## GitHub Pages deployment

This repo includes `.github/workflows/deploy-web-pages.yml` to publish the web build to GitHub Pages from `main`.

Important:

- GitHub Pages only hosts the static web client.
- The Signals page still needs a running API server.
- Set the repository variable `VITE_API_BASE` to your hosted API origin, for example `https://your-api.example.com`.
- The workflow sets `VITE_BASE_PATH` to `/<repo-name>/` so asset URLs work on a project Pages site.

After merging to `main`, enable Pages in GitHub repo settings with **Source: GitHub Actions**.

## Render / Vercel deployment

`render.yaml` at the repo root can deploy both pieces on Render:

- `polymarket-orderflow-api` — Node API service.
- `polymarket-orderflow-web` — static Vite web site.

Set the static site's `VITE_API_BASE` to the Render API service URL after the API is created, for example
`https://polymarket-orderflow-api.onrender.com`.

`vercel.json` can deploy the static web client on Vercel. Vercel still needs `VITE_API_BASE` pointed at a hosted API
(Render is the better fit for the API because this server uses a long-running Node process and WebSockets).

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
