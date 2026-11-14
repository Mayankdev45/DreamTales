# DreamTales — AI Story Creator

Scene-by-scene AI stories via OpenRouter. Scenes stream into the page as they are written.

## Setup
```bash
npm install
cp .env.example .env     # then set OPENROUTER_API_KEY
npm start                # http://localhost:5000
```
Node >= 18 required. Key: https://openrouter.ai/keys

## Config (.env)
| Var | Default | Note |
|---|---|---|
| `OPENROUTER_API_KEY` | — | required |
| `STORY_MODEL` | `nvidia/nemotron-3-ultra-550b-a55b:free` | free list rotates; update if it 404s |
| `PORT` | `5000` | |
| `SITE_URL` | `http://localhost:PORT` | sent as HTTP-Referer |
| `RATE_MAX` | `6` | stories per IP per 10 min |

## Structure
```
server.js        API + streaming proxy
public/          index.html, style.css, script.js (only this folder is served)
```

## Notes
- Free models: limited daily requests, single host, may be slow/busy at peak.
- Behind a reverse proxy, add `app.set("trust proxy", 1)` so rate limiting sees real IPs.
