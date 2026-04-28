# Confluence Intranet Mirror - API Documentation

## Endpoints Overview

### Base URL
```
http://localhost:3000/api
```

---

## Health Check

### GET /health
Health check endpoint

```bash
curl http://localhost:3000/api/health
```

Response:
```json
{
  "status": "ok"
}
```

---

## Authentication

### POST /auth/login
Get JWT token for admin operations

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d {
    "username": "admin",
    "password": "your-password"
  }
```

Response:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "message": "Login successful"
}
```

**Usage in requests:**
```bash
curl http://localhost:3000/api/pages \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## Pages Endpoints

### GET /pages
Get paginated list of all pages

**Query Parameters:**
- `limit` (default: 50) - Items per page
- `offset` (default: 0) - Skip N items

```bash
curl http://localhost:3000/api/pages?limit=10&offset=0
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "confluence_id": "123456",
      "title": "Installation Guide",
      "content": "How to install...",
      "space_key": "NORDREST",
      "url": "https://...",
      "last_synced": "2026-04-28T10:30:00Z"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 150
  }
}
```

### GET /pages/:id
Get specific page by Confluence ID

```bash
curl http://localhost:3000/api/pages/123456
```

Response:
```json
{
  "success": true,
  "data": {
    "id": 1,
    "confluence_id": "123456",
    "title": "Installation Guide",
    "content": "...",
    "raw_html": "<p>...</p>",
    "space_key": "NORDREST",
    "url": "https://...",
    "last_synced": "2026-04-28T10:30:00Z"
  }
}
```

### GET /pages/search/query
Search pages by title and content

**Query Parameters:**
- `q` (required) - Search query

```bash
curl "http://localhost:3000/api/pages/search/query?q=installation"
```

Response:
```json
{
  "success": true,
  "query": "installation",
  "results": [
    {
      "id": 1,
      "confluence_id": "123456",
      "title": "Installation Guide",
      "content": "...",
      "space_key": "NORDREST"
    }
  ],
  "count": 5
}
```

---

## AI Endpoints

### GET /ai/pages/:pageId/summary
Get AI-optimized summary for a page

Includes chunks, embeddings, and related pages

```bash
curl http://localhost:3000/api/ai/pages/1/summary
```

Response:
```json
{
  "success": true,
  "data": {
    "page": {
      "id": 1,
      "title": "Installation Guide",
      "...": "..."
    },
    "chunks": [
      {
        "id": 10,
        "chunk_index": 0,
        "content": "First paragraph...",
        "chunk_type": "paragraph",
        "token_count": 150,
        "metadata": {
          "language": "sv",
          "confidence": 0.95,
          "context": "Title: Installation Guide | ..."
        }
      }
    ],
    "relatedPages": [...],
    "statistics": {
      "totalChunks": 5,
      "totalTokens": 750,
      "totalCharacters": 3000,
      "chunkTypes": ["paragraph", "heading", "code"],
      "relatedPagesCount": 3
    }
  }
}
```

### GET /ai/pages/:pageId/chunks
Get semantic chunks for a page

**Query Parameters:**
- `limit` (default: 50)
- `offset` (default: 0)

```bash
curl http://localhost:3000/api/ai/pages/1/chunks?limit=10
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": 10,
      "page_id": 1,
      "chunk_index": 0,
      "content": "Paragraph content...",
      "chunk_type": "paragraph",
      "character_count": 250,
      "token_count": 60,
      "start_position": 0,
      "metadata": {...}
    }
  ],
  "pagination": {
    "total": 5,
    "limit": 10,
    "offset": 0
  }
}
```

### GET /ai/pages/:pageId/related
Get pages related to a specific page

```bash
curl http://localhost:3000/api/ai/pages/1/related
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": 2,
      "title": "Configuration Guide",
      "relationship_type": "references",
      "context": "See also..."
    }
  ],
  "count": 3
}
```

### GET /ai/context-window/:pageId
Get content optimized for LLM context window

**Query Parameters:**
- `maxTokens` (default: 8000) - Max tokens to include

```bash
curl "http://localhost:3000/api/ai/context-window/1?maxTokens=4000"
```

Response:
```json
{
  "success": true,
  "data": {
    "page": {...},
    "chunks": [/* selected chunks fitting in token limit */],
    "statistics": {
      "tokensUsed": 3500,
      "tokensAvailable": 4000,
      "chunksIncluded": 3
    }
  }
}
```

### GET /ai/statistics
Get AI content statistics

```bash
curl http://localhost:3000/api/ai/statistics
```

Response:
```json
{
  "success": true,
  "data": {
    "totalPages": 42,
    "totalChunks": 285,
    "totalTokens": 125000,
    "embeddingsGenerated": 281,
    "lastSync": "2026-04-28T10:30:00Z"
  }
}
```

### POST /ai/search/semantic
Search using semantic similarity (requires embeddings)

```bash
curl -X POST http://localhost:3000/api/ai/search/semantic \
  -H "Content-Type: application/json" \
  -d {
    "query": "how to install",
    "embedding": [0.1, 0.2, ...],
    "limit": 5
  }
```

---

## Q&A Endpoints

### POST /qa/ask
Ask a question and get an answer with sources

```bash
curl -X POST http://localhost:3000/api/qa/ask \
  -H "Content-Type: application/json" \
  -d {
    "question": "How do I configure the system?"
  }
```

Response:
```json
{
  "success": true,
  "data": {
    "answer": "Based on the documentation: Configuration involves...",
    "sources": [
      {
        "chunkId": 42,
        "pageId": 5,
        "title": "Configuration Guide",
        "excerpt": "To configure the system, follow these steps...",
        "relevance": 0.92
      },
      {
        "chunkId": 43,
        "pageId": 5,
        "title": "Configuration Guide",
        "excerpt": "Environment variables must be set as follows...",
        "relevance": 0.87
      }
    ],
    "confidence": 0.85
  }
}
```

### GET /qa/search
Search for related content

**Query Parameters:**
- `q` (required) - Search query

```bash
curl "http://localhost:3000/api/qa/search?q=configuration"
```

Response:
```json
{
  "success": true,
  "query": "configuration",
  "results": [
    {
      "id": 42,
      "page_id": 5,
      "content": "...",
      "chunk_type": "paragraph",
      "title": "Configuration Guide",
      "url": "https://...",
      "space_key": "NORDREST",
      "relevance": 0.92
    }
  ],
  "count": 3
}
```

---

## Admin Endpoints

**Note:** Most admin endpoints require JWT authentication

### GET /admin/status
Get synchronization status

```bash
curl http://localhost:3000/api/admin/status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Response:
```json
{
  "success": true,
  "stats": {
    "total": 42,
    "lastSync": "2026-04-28T10:30:00Z"
  }
}
```

### POST /admin/sync
Manual sync from Confluence

```bash
curl -X POST http://localhost:3000/api/admin/sync \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Response:
```json
{
  "success": true,
  "message": "Synced 42 pages, created 285 chunks, generated 281 embeddings",
  "stats": {
    "pagesSync": 42,
    "chunksCreated": 285,
    "embeddingsGenerated": 281
  }
}
```

### POST /admin/generate-embeddings
Generate embeddings for all chunks (background job)

```bash
curl -X POST http://localhost:3000/api/admin/generate-embeddings \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### POST /admin/reprocess/:pageId
Reprocess chunks for a specific page

```bash
curl -X POST http://localhost:3000/api/admin/reprocess/1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Error Responses

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": "Error description"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad request (missing parameters)
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not found
- `500` - Server error

---

## Rate Limiting

Not implemented yet. Recommended for production:
- 100 requests per minute for general endpoints
- 10 requests per minute for sync endpoints

---

## Best Practices

1. **Caching**: Cache responses from `/ai/*` endpoints (they rarely change between syncs)
2. **Pagination**: Always use pagination for large result sets
3. **Token Management**: Rotate JWT secrets every 90 days
4. **Error Handling**: Always check `success` field before using `data`
5. **Q&A Usage**: Provide context for better answers
