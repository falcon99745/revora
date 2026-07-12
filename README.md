# Revora — Backend

The whole study app now runs on a small Node backend that does two jobs:

1. **AI proxy** (`/api/ai`) — all AI features (study chat, mock tests, flashcards,
   notes, diagrams) call the server, and the server calls Groq using a key that
   stays on the server. The API key is **never** exposed in the browser.
2. **Persistent storage** (`/api/storage/*`) — profiles, streaks, mastery scores,
   saved decks/notes/diagrams, planner, and usage limits are saved on the server
   (in `data/store.json`) instead of only in one browser.

> Login is intentionally left as-is: it's a lightweight client-side profile, not
> real authentication. Everything else is fully wired to the backend.

---

## Where do I paste my API key?

Open the **`.env`** file in this folder and put your key after `GROQ_API_KEY=`:

```
GROQ_API_KEY=gsk_your_key_here
```

Get a free key at **https://console.groq.com/keys**. Then restart the server.

That's the only place a key ever needs to go.

---

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

Use `npm run dev` to auto-restart on file changes.

---

## Endpoints

| Method | Path                    | Purpose                          |
| ------ | ----------------------- | -------------------------------- |
| POST   | `/api/ai`               | Proxy an AI chat completion      |
| GET    | `/api/storage/get`      | Read one key                     |
| POST   | `/api/storage/set`      | Write one key                    |
| GET    | `/api/storage/list`     | List keys by prefix              |
| POST   | `/api/storage/delete`   | Delete one key                   |
| GET    | `/api/health`           | Check server + AI config status  |

Data lives in `data/store.json` (created automatically, git-ignored).
Delete that file to reset all app data.
