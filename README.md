# habit-tracker-serveur

API backend pour l'application Habit Tracker (auth, sync, reset password, citations Gemini, personnalisation IA).

## Stack

- Node.js + Express
- PostgreSQL
- Docker / Docker Compose
- Traefik (HTTPS)
- Google Gemini (`@google/genai`)

## Demarrage

1. Copier `.env.example` vers `.env` et renseigner les secrets.
2. Lancer :

```bash
docker compose up -d --build
```

## Endpoints principaux

- `GET /api/health`
- `POST /api/auth/login`, `POST /api/auth/register`
- `GET/POST /api/sync`
- `GET /api/quotes/weekly`
- `GET/PUT /api/ai/settings`
- `GET /api/ai/habit-messages`
- `GET /api/ai/spontaneous-plan`

L'app mobile correspondante : [motivation_mobile_app](https://github.com/gillesdegue/motivation_mobile_app).
