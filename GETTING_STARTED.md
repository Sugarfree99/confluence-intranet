# Getting Started - 5 Minutes to Production

En steg-för-steg guide för att komma igång snabbt.

## Förutsättningar

- Node.js 18+
- PostgreSQL 12+
- Confluence API-token

## 1. Clone & Install (1 min)

```bash
cd confluence-intranet

# Installera dependencies
npm install

# Kompilera TypeScript
npm run build
```

## 2. Konfigurera (1 min)

```bash
# Kopiera template
cp .env.example .env

# Redigera .env med dina uppgifter:
# CONFLUENCE_BASE_URL=https://nordrest.atlassian.net
# CONFLUENCE_USERNAME=din-email@example.com
# CONFLUENCE_API_TOKEN=din-token-från-atlassian
```

**Få API-token:**
1. Gå till https://id.atlassian.com/manage-profile/security/api-tokens
2. Klicka "Create API token"
3. Kopiera token till `.env`

## 3. Sätt upp Database (1 min)

```bash
# Skapa database
createdb confluence_mirror

# Migrera schema
npm run sync
```

## 4. Starta Backend (1 min)

```bash
npm run dev
```

**Output:**
```
Server running on port 3000
Database initialized
Scheduled sync configured to run every 60 minutes
```

Testa: `curl http://localhost:3000/api/health`

## 5. Starta Frontend (1 min)

I en ny terminal:

```bash
cd confluence-ui  # eller skapa ny project
npm create vite@latest . -- --template react-ts
npm install axios react-router-dom zustand
npm run dev
```

Öppna: `http://localhost:5173`

---

## ✅ Verifiering

### Backend Endpoints

```bash
# Health check
curl http://localhost:3000/api/health

# Admin login
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}'

# Manual sync
curl -X POST http://localhost:3000/api/admin/sync \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Database Verifiering

```bash
psql confluence_mirror

# Se tabeller
\dt

# Count sidor
SELECT COUNT(*) FROM pages;

# Se chunks
SELECT COUNT(*) FROM chunks;

# Se embeddings
SELECT COUNT(*) FROM embeddings;
```

---

## 🚀 Typiska Use Cases

### Use Case 1: Ställ en fråga

```bash
curl -X POST http://localhost:3000/api/qa/ask \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Hur installerar jag detta?"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "answer": "Baserat på dokumentationen: Installation görs genom...",
    "sources": [
      {
        "title": "Installation Guide",
        "excerpt": "Steg 1...",
        "relevance": 0.95
      }
    ],
    "confidence": 0.87
  }
}
```

### Use Case 2: Sök i innehål

```bash
curl "http://localhost:3000/api/pages/search/query?q=installation"
```

### Use Case 3: Hämta AI-sammanfattning

```bash
curl http://localhost:3000/api/ai/pages/1/summary
```

---

## 🔧 Troubleshooting

| Problem | Lösning |
|---------|---------|
| **"Cannot connect to database"** | Kolla att PostgreSQL körs: `psql -U postgres` |
| **"Confluence API error"** | Verifiera API-token och URL i `.env` |
| **"Port 3000 already in use"** | Ändra PORT i `.env` eller kill process: `lsof -i :3000` |
| **"CORS error"** | Backend startar med default CORS för `localhost:5173` |
| **"No OpenAI API"** | OK för dev - använder fallback embeddings |

---

## 📚 Nästa Steg

- [ ] [API Documentation](API_DOCUMENTATION.md) - Alla endpoints
- [ ] [Architecture](ARCHITECTURE.md) - AI-integration djupa dykningar
- [ ] [Web UI Setup](WEB_UI_SETUP.md) - Frontend components
- [ ] Skapa mer avancerade AI-queries
- [ ] Deploy till production

---

## 💡 Pro Tips

1. **Manuell Sync under development:**
   ```bash
   npm run sync
   ```

2. **Ändra sync-intervall:**
   ```
   SYNC_INTERVAL_MINUTES=15  # Synka var 15:e minut
   ```

3. **Öka log-nivå för debugging:**
   ```
   LOG_LEVEL=debug
   ```

4. **Testa embeddings generation:**
   ```bash
   # Kräver OPENAI_API_KEY i .env
   curl -X POST http://localhost:3000/api/admin/generate-embeddings
   ```

5. **Exportera data för analyser:**
   ```bash
   # Backup database
   pg_dump confluence_mirror > backup.sql
   ```

---

**Du är nu igång med Confluence-spegeln! 🎉**

Nästa: [Läs API-dokumentationen](API_DOCUMENTATION.md) för alla möjligheter.
