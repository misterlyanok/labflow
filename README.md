# LabFlow MVP

Telegram Mini App UX-first MVP for student laboratory schedules and electronic queues.

## Run

```bash
npm install
npm run dev
```

## Architecture

- `src/types.ts` — shared domain models and queue/registration states.
- `src/api.ts` — mock API abstraction with simulated latency. Replace implementations here with backend calls.
- `src/main.tsx` — screen orchestration and feature-level UI for the MVP.
- `src/styles.css` — mobile-first visual system.

The mock supports login, name setup, subjects, schedule, lesson details, join/leave queue, profile notifications and history. The queue status model is ready for realtime updates via a future `queueRealtime.subscribe(queueId, callback)` adapter.

## Deployment

- Local development uses mock data when `VITE_API_URL` is empty.
- Set `VITE_API_URL` to the deployed Render API URL to use the backend.
- The included GitHub Actions workflow deploys the Vite build to GitHub Pages.
- The Render service can be created from `render.yaml`.
