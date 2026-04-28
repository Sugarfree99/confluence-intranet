# AI Integration & System Architecture

En komplett guide för hur Confluence-spegeln är designad för AI-konsumtion.

## 📊 Dataflöde

```
┌─────────────┐
│  Confluence │
│  (Online)   │
└──────┬──────┘
       │ API (Confluence REST)
       ↓
┌─────────────────────────┐
│  Confluence Service     │
│  - Hämtar sidor         │
│  - Extraherar HTML      │
└──────┬──────────────────┘
       │
       ↓
┌─────────────────────────────────┐
│  Text Chunking Service          │
│  - Semantisk uppdelning         │
│  - ~300-400 tokens/chunk        │
│  - Bevarar struktur             │
└──────┬──────────────────────────┘
       │
       ↓
┌──────────────────────────────────┐
│  PostgreSQL Database             │
│  - pages tabellen               │
│  - chunks tabellen              │
│  - embeddings tabellen          │
│  - relationships tabellen       │
└──────┬───────────────────────────┘
       │
       ├─→ Embedding Service (OpenAI)
       │   └→ Vector Storage
       │
       └─→ AI Optimization Service
           ├─ Metadata extraction
           ├─ Quality scoring
           └─ Context building
       
       ↓
┌──────────────────────────────────┐
│  REST API Endpoints              │
│  - /api/pages/*                 │
│  - /api/ai/*                    │
│  - /api/qa/*                    │
└──────┬───────────────────────────┘
       │
       ↓
┌──────────────────────────────────┐
│  AI Applications                 │
│  - Web UI (React/Vue)           │
│  - ChatBot                       │
│  - LLM Integration               │
│  - RAG Pipeline                  │
└──────────────────────────────────┘
```

## 🧠 AI-Optimerad Datastruktur

### Level 1: Original Pages
```sql
pages
├── id: Integer (unique)
├── confluence_id: String (from Confluence)
├── title: String
├── content: Text (plain text extracted)
├── raw_html: Text (original HTML)
├── space_key: String (NORDREST)
├── url: String
└── last_synced: Timestamp
```

**Use case:** Grundläggande sökning, visning av innehål

### Level 2: Semantic Chunks
```sql
chunks
├── id: Integer
├── page_id: Foreign Key → pages
├── chunk_index: Integer (order on page)
├── content: Text (200-400 tokens)
├── chunk_type: String
│   ├── "paragraph"
│   ├── "heading"
│   ├── "code"
│   ├── "list"
│   ├── "table"
│   └── "quote"
├── token_count: Integer (estimated)
├── character_count: Integer
├── start_position: Integer (in original)
└── metadata: JSONB
    ├── language: "sv"
    ├── confidence: 0.95
    ├── context: "surrounding text..."
    └── originalType: "paragraph"
```

**Use case:** AI processing, token budgeting, context windows

### Level 3: Vector Embeddings
```sql
embeddings
├── id: Integer
├── chunk_id: Foreign Key → chunks
├── embedding: VECTOR(1536)
│   └── 1536-dimensional vector
│       representing semantic meaning
├── model: String ("text-embedding-3-small")
└── created_at: Timestamp
```

**Calculations:**
- Cosine similarity for semantic search
- L2 distance for clustering
- KNN for related content

**Use case:** Semantic search, similarity matching, RAG retrieval

### Level 4: Page Relationships
```sql
page_relationships
├── id: Integer
├── source_page_id: FK → pages
├── target_page_id: FK → pages
├── relationship_type: String
│   ├── "references"
│   ├── "linked"
│   ├── "related"
│   └── "prerequisite"
├── context: Text (why linked)
└── created_at: Timestamp
```

**Use case:** Context building, knowledge graph, related documents

### Level 5: Sync Logs
```sql
sync_logs
├── id: Integer
├── sync_type: String ("pages", "chunks", "embeddings", "full_sync")
├── status: String ("success", "failed", "processing")
├── items_processed: Integer
├── items_failed: Integer
├── error_message: Text (if failed)
├── metadata: JSONB
└── timestamps (started_at, completed_at)
```

**Use case:** Monitoring, debugging, statistics

## 🔍 Intelligent Text Chunking

### Algorithm

1. **Parse HTML** - Extrahera semantiska element
   ```
   <h2> → heading chunk
   <p> → paragraph chunk
   <code> → code chunk
   <ul/ol> → list chunk
   <table> → table chunk
   ```

2. **Estimate Tokens** - Ungefärlig beräkning
   ```
   tokens ≈ words × 1.3
   text-embedding-3-small accepts up to ~8000 tokens
   ```

3. **Smart Splitting** - Respektera gränser
   - Inte mitt i en sats
   - Inte mitt i en lista-punkt
   - Respektera heading-hierarki

4. **Size Optimization**
   ```
   TARGET: 300-400 tokens per chunk
   - Under 200 tokens: Slå ihop med nästa
   - Över 500 tokens: Dela upp
   ```

5. **Context Preservation**
   ```
   Each chunk includes:
   - Previous chunk's title/summary
   - Current document title
   - Next chunk's title
   - Section hierarchy
   ```

### Chunking Strategy

```typescript
// pseudo-code
for element in html_elements {
  if (current_chunk_tokens + element_tokens < MAX_TOKENS) {
    current_chunk += element
  } else if (element.type == "heading" || current_chunk.tokens > 200) {
    save_chunk(current_chunk)
    current_chunk = element
  }
}
```

## 🤖 AI Konsumtion Patterns

### Pattern 1: RAG (Retrieval Augmented Generation)

```
User Question
    ↓
Query Embedding (OpenAI)
    ↓
Vector Search (pgvector)
    ↓
Top-K Chunks (relevance ranked)
    ↓
Build Context Window
    ↓
LLM API Call (with context)
    ↓
Answer + Sources
```

**Implementation:**
```typescript
// 1. Generate question embedding
const questionEmbedding = await embeddingService.generateEmbedding(question);

// 2. Find similar chunks
const relevantChunks = await qaService.searchRelevantChunks(question);

// 3. Build context
const context = relevantChunks
  .map(c => c.content)
  .slice(0, 5) // Top 5
  .join("\n\n");

// 4. Call LLM
const answer = await llm.complete({
  system: "Du är en hjälpsam assistent",
  messages: [{
    role: "user",
    content: `Baserat på detta innehål:\n${context}\n\nSvar på: ${question}`
  }]
});
```

### Pattern 2: Context Window Optimization

```
Get Page Summary
    ↓
Find All Chunks
    ↓
Sort by Relevance/Position
    ↓
Select chunks until Token Limit
    ↓
Return Optimized Context
```

**API:**
```
GET /api/ai/context-window/:pageId?maxTokens=4000
```

**Response:**
```json
{
  "chunks": [
    { "content": "...", "tokens": 150 },
    { "content": "...", "tokens": 200 }
  ],
  "statistics": {
    "tokensUsed": 2100,
    "tokensAvailable": 4000,
    "efficiency": 0.525
  }
}
```

### Pattern 3: Knowledge Graph Traversal

```
page_id = 42
    ↓
Find Related Pages
    ├─ references (3 pages)
    ├─ linked (2 pages)
    └─ prerequisite (1 page)
    ↓
For each relation:
  - Get page summary
  - Include in context
    ↓
Build enriched context
```

## 📈 Performance Optimization

### Indexing Strategy

```sql
-- Primary search paths
CREATE INDEX idx_chunks_content_tsvector ON chunks 
  USING GIN(to_tsvector('english', content));

CREATE INDEX idx_pages_title_tsvector ON pages 
  USING GIN(to_tsvector('english', title));

-- Vector search (requires pgvector)
CREATE INDEX idx_embeddings_vector ON embeddings 
  USING ivfflat (embedding vector_cosine_ops);

-- Foreign key traversal
CREATE INDEX idx_chunks_page_id ON chunks(page_id);
CREATE INDEX idx_embeddings_chunk_id ON embeddings(chunk_id);
```

### Caching Strategy

```
Frontend Cache:
├─ Pages list (5 min)
├─ AI summaries (15 min)
├─ Search results (10 min)
└─ QA results (per session)

Backend Cache (optional Redis):
├─ Embeddings similarity (1 hour)
├─ Page metadata (1 hour)
└─ Sync stats (5 min)
```

## 🔐 Security for AI Integration

### API Authentication
```typescript
// All /api/ai/* endpoints support optional JWT
// For public: No token needed
// For private use cases: Add JWT header
Authorization: Bearer {token}
```

### Rate Limiting Recommendations
```
Public endpoints: 100 req/min
AI search: 50 req/min
QA: 20 req/min
Admin/sync: 10 req/min
```

### Data Privacy
```
- No API keys exposed
- Embeddings stored encrypted (optional)
- Sync logs retained 30 days
- PII handling: depends on Confluence content
```

## 🚀 Deployment for AI

### Development
```bash
# 1. Start backend
npm run dev

# 2. Start frontend
cd ../confluence-ui
npm run dev

# 3. Backend: http://localhost:3000
# 4. Frontend: http://localhost:5173
```

### Production with Docker

**Dockerfile:**
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

**Docker Compose:**
```yaml
version: '3.8'

services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: confluence_mirror
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data

  backend:
    build: .
    ports:
      - "3000:3000"
    environment:
      DB_HOST: postgres
      CONFLUENCE_API_TOKEN: ${CONFLUENCE_API_TOKEN}
    depends_on:
      - postgres

  frontend:
    build: ./confluence-ui
    ports:
      - "5173:5173"

volumes:
  postgres_data:
```

## 📊 Monitoring & Analytics

### Key Metrics

```
1. Sync Health
   - Pages synced per hour
   - Chunks created per sync
   - Embeddings generated per sync
   - Sync failure rate

2. Search Performance
   - Average search time
   - Results relevance score
   - Cache hit rate

3. AI Usage
   - Questions answered
   - Average confidence
   - API calls per hour
   - Token usage
```

### Logging

```
Full logs:
  - Every API call
  - Sync operations
  - Errors with stack traces
  - Performance metrics

Example:
  {
    "timestamp": "2026-04-28T10:30:00Z",
    "level": "info",
    "method": "POST",
    "path": "/api/qa/ask",
    "responseTime": 245,
    "tokensUsed": 1200
  }
```

## 🔄 Integration with LLM APIs

### OpenAI Integration

```typescript
import { OpenAI } from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function answerWithGPT(question, context) {
  const response = await client.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "system",
        content: "Du är en hjälpsam assistent baserad på denna dokumentation"
      },
      {
        role: "user",
        content: `Kontext:\n${context}\n\nFråga: ${question}`
      }
    ],
    temperature: 0.7,
    max_tokens: 2000,
  });

  return response.choices[0].message.content;
}
```

### Claude Integration

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

async function answerWithClaude(question, context) {
  const response = await client.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Baserat på detta innehål:\n${context}\n\nSvar på: ${question}`
      }
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}
```

---

**Nästa steg:** Integrera en LLM API för att aktivera full RAG pipeline.
