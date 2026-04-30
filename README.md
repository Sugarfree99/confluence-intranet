# Confluence Intranet Mirror

Ett system för att spegla en Atlassian Confluence-intranet lokalt med AI-optimerad innehållslagring och intelligent sökning.

**[👉 Se full API-dokumentation](API_DOCUMENTATION.md)**

## Features

- 🔄 **Automatisk synkronisering** från Confluence
- 💾 **PostgreSQL-lagring** med full-text search
- 📝 **Smart text chunking** - Semantisk uppdelning av innehål
- 🧠 **AI-optimerad struktur** - Embeddings och vektorsökning  
- 🚀 **REST API** för AI-integration
- 🔐 **JWT-autentisering** för säker åtkomst
- 🤖 **Q&A-modul** - Besvara frågor från innehållet
- 📊 **En strukturerad data** för LLM-konsumtion

## Quick Start

### Installation

```bash
npm install
```

### Konfiguration

1. Kopiera `.env.example` till `.env`
2. Skapa Confluence API-token: https://id.atlassian.com/manage-profile/security/api-tokens
3. Fyll i `.env` med dina Confluence-uppgifter

### Sätt upp databasen (Docker)

Databasen körs i Docker. Se till att inga andra Postgres-instanser
lyssnar på port 5432 (stoppa lokal Postgres-tjänst om den finns).

```bash
npm run db:up        # startar Postgres-containern (auto-applicerar schema + migrations vid första körning)
npm run build
npm run sync         # fyller databasen från Confluence
```

Användbara DB-kommandon:

```bash
npm run db:logs      # följ container-loggar
npm run db:psql      # öppna psql i containern
npm run db:migrate   # kör om migrations mot existerande DB
npm run db:down      # stoppa containern (data behålls)
npm run db:reset     # WIPE: stoppa + radera volym + starta om (data försvinner)
```

### Starta servern

```bash
npm run dev
```

Servern startar på `http://localhost:3000`

## API Översikt

| Ändamål | Endpoint | Metod |
|---------|----------|--------|
| **Health check** | `/api/health` | GET |
| **Hämta sidor** | `/api/pages` | GET |
| **Sök sidor** | `/api/pages/search/query` | GET |
| **AI-sammanfattning** | `/api/ai/pages/:id/summary` | GET |
| **Ställ fråga** | `/api/qa/ask` | POST |
| **Sök relaterad** | `/api/qa/search` | GET |
| **Synkronisera** | `/api/admin/sync` | POST |

**[Se all dokumentation →](API_DOCUMENTATION.md)**

## Datastruktur för AI

Systemet organiserar Confluence-innehål i flera lager för optimal AI-användning:

```
Confluence Pages (original)
    ↓
Semantic Chunks (200-400 tokens vardera)
    ↓
Embeddings (vektorer för sökning)
    ↓
Metadata & Relationships
    ↓
AI-ready Context Windows
```

### Text Chunking

Innehål delas intelligently på semantiska gränser:
- Bevarar struktur (headings, listor, kod)
- ~300-400 tokens per chunk
- Kontextuell information inkluderas
- Chunk-typ märks (paragraph, code, list, etc.)

### Embeddings

Varje chunk får en vektor för semantisk sökning:
- Model: `text-embedding-3-small`
- Dimension: 1536
- Fallback till pseudo-embeddings utan API-nyckel

## Miljövariabler

```bash
# Confluence
CONFLUENCE_BASE_URL=https://nordrest.atlassian.net
CONFLUENCE_USERNAME=din-email@example.com
CONFLUENCE_API_TOKEN=din-token

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=confluence_mirror
DB_USER=postgres
DB_PASSWORD=ditt-lösenord

# Server
PORT=3000
NODE_ENV=development

# Security
JWT_SECRET=super-secret-key
ADMIN_PASSWORD=admin

# AI (optional)
OPENAI_API_KEY=sk-...

# Sync
SYNC_INTERVAL_MINUTES=60
```

## Commands

```bash
npm run dev              # Start i development mode
npm run build            # Compile TypeScript
npm run sync             # Manuell synkronisering från Confluence
npm start                # Production mode
npm test                 # Run tests
```

## Arkitektur

```
src/
├── services/
│   ├── confluenceService.ts    # Confluence API klient
│   ├── dbService.ts            # Database operationer
│   ├── aiOptimizationService.ts # AI chunking & embeddings
│   ├── textChunkingService.ts   # Semantisk text-splitting
│   ├── embeddingService.ts      # Vector embeddings
│   └── qaService.ts            # Q&A functionality
├── routes/
│   ├── pages.ts        # Page endpoints
│   ├── ai.ts          # AI endpoints
│   ├── qa.ts          # Q&A endpoints  
│   └── admin.ts       # Admin endpoints
├── middleware/
│   └── auth.ts        # JWT authentication
└── index.ts           # Main Express app

db/
└── schema.sql         # PostgreSQL schema
```

## Exempel: AI Q&A

```bash
# Ställ en fråga baserad på Confluence-innehållet
curl -X POST http://localhost:3000/api/qa/ask \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Hur installerar jag systemet?"
  }'
```

Svar med relevanta källor:
```json
{
  "success": true,
  "data": {
    "answer": "Baserad på dokumentationen: Installation görs genom...",
    "sources": [
      {
        "title": "Installation Guide",
        "excerpt": "Steg 1: Klona projektet...",
        "relevance": 0.95
      }
    ],
    "confidence": 0.87
  }
}
```

## Säkerhet

- JWT-tokens för autentisering
- API-credentials i `.env` (inte i kod)
- Parameterized queries mot SQL-injection
- HTTPS rekommenderas för production
- Rate limiting kan konfigureras

## Nästa Steg

- Web-gränssnitt (React/Vue)
- Avancerade embeddings med pgvector
- LLM-integration (OpenAI, Claude)
- Webhook-stöd för real-time sync
- Multi-language support
- Analytics & metrics
- Caching (Redis)

## Troubleshooting

**"Cannot connect to database"**
```bash
# Verifiera PostgreSQL
psql -U postgres
# Skapa databas
createdb confluence_mirror
```

**"Confluence API error"**
- Kontrollera CONFLUENCE_API_TOKEN
- Verifiera CONFLUENCE_BASE_URL
- Token måste genereras från Atlassian ID

**"No OpenAI key"**
- Systemet funktionerar utan (använder fallback embeddings)
- Lägg till OPENAI_API_KEY för production

## Licens

MIT

---

**[📖 Se full API-dokumentation för alla endpoints](API_DOCUMENTATION.md)**
