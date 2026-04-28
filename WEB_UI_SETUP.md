# Web UI Setup Guide

Denna guide visar hvordan man bygger ett web-gränssnitt för Confluence-spegeln.

## Option 1: React with Vite (Rekommenderad)

Snabbaste sättet att starta:

```bash
# Skapa Vite React app
npm create vite@latest confluence-ui -- --template react-ts

cd confluence-ui

# Installera dependencies
npm install axios react-router-dom zustand @tailwindcss/typography tailwindcss postcss autoprefixer

# Initiera Tailwind
npx tailwindcss init -p
```

### Projektstruktur

```
confluence-ui/
├── src/
│   ├── components/
│   │   ├── PageList.tsx
│   │   ├── PageView.tsx
│   │   ├── SearchBar.tsx
│   │   ├── QAForm.tsx
│   │   └── AIChunks.tsx
│   ├── pages/
│   │   ├── Home.tsx
│   │   ├── Browse.tsx
│   │   ├── Search.tsx
│   │   └── QA.tsx
│   ├── services/
│   │   └── api.ts
│   ├── store/
│   │   └── useStore.ts
│   ├── App.tsx
│   └── main.tsx
├── index.html
├── tailwind.config.js
└── vite.config.ts
```

### API Service (`src/services/api.ts`)

```typescript
import axios from 'axios';

const API_BASE = 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token if available
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const pageService = {
  getPages: (limit = 50, offset = 0) =>
    api.get('/pages', { params: { limit, offset } }),
  getPage: (id: string) =>
    api.get(`/pages/${id}`),
  search: (q: string) =>
    api.get('/pages/search/query', { params: { q } }),
};

export const aiService = {
  getSummary: (pageId: number) =>
    api.get(`/ai/pages/${pageId}/summary`),
  getChunks: (pageId: number, limit = 10) =>
    api.get(`/ai/pages/${pageId}/chunks`, { params: { limit } }),
  getContextWindow: (pageId: number, maxTokens = 8000) =>
    api.get(`/ai/context-window/${pageId}`, { params: { maxTokens } }),
};

export const qaService = {
  ask: (question: string) =>
    api.post('/qa/ask', { question }),
  search: (q: string) =>
    api.get('/qa/search', { params: { q } }),
};

export const authService = {
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }),
};

export default api;
```

### State Management (`src/store/useStore.ts`)

```typescript
import { create } from 'zustand';

interface Page {
  id: number;
  confluence_id: string;
  title: string;
  content: string;
  space_key: string;
  url: string;
}

interface QAResult {
  answer: string;
  sources: Array<{
    chunkId: number;
    pageId: number;
    title: string;
    excerpt: string;
    relevance: number;
  }>;
  confidence: number;
}

interface Store {
  pages: Page[];
  currentPage: Page | null;
  searchResults: Page[];
  qaResults: QAResult | null;
  loading: boolean;
  error: string | null;
  
  setPages: (pages: Page[]) => void;
  setCurrentPage: (page: Page | null) => void;
  setSearchResults: (results: Page[]) => void;
  setQAResults: (results: QAResult | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useStore = create<Store>((set) => ({
  pages: [],
  currentPage: null,
  searchResults: [],
  qaResults: null,
  loading: false,
  error: null,
  
  setPages: (pages) => set({ pages }),
  setCurrentPage: (page) => set({ currentPage: page }),
  setSearchResults: (results) => set({ searchResults: results }),
  setQAResults: (results) => set({ qaResults: results }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));
```

### Komponenter

**SearchBar.tsx:**
```typescript
import { useState } from 'react';
import { pageService, qaService } from '../services/api';
import { useStore } from '../store/useStore';

export function SearchBar() {
  const [query, setQuery] = useState('');
  const { setSearchResults, setLoading } = useStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await pageService.search(query);
      setSearchResults(response.data.results);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSearch} className="flex gap-2 mb-6">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Sök i dokumentationen..."
        className="flex-1 px-4 py-2 border rounded-lg"
      />
      <button
        type="submit"
        className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
      >
        Sök
      </button>
    </form>
  );
}
```

**QAForm.tsx:**
```typescript
import { useState } from 'react';
import { qaService } from '../services/api';
import { useStore } from '../store/useStore';

export function QAForm() {
  const [question, setQuestion] = useState('');
  const { setQAResults, setLoading } = useStore();

  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const response = await qaService.ask(question);
      setQAResults(response.data.data);
      setQuestion('');
    } finally {
      setLoading(false);
    }
  };

  const { qaResults } = useStore();

  return (
    <div className="max-w-2xl mx-auto">
      <form onSubmit={handleAsk} className="mb-8">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ställ en fråga om dokumentationen..."
          className="w-full px-4 py-3 border rounded-lg text-lg"
        />
        <button
          type="submit"
          className="mt-2 w-full px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
        >
          Ställ fråga
        </button>
      </form>

      {qaResults && (
        <div className="bg-gray-50 p-6 rounded-lg">
          <h3 className="text-lg font-semibold mb-4">Svar:</h3>
          <p className="mb-6 text-gray-800">{qaResults.answer}</p>

          {qaResults.sources.length > 0 && (
            <div className="border-t pt-4">
              <h4 className="font-semibold mb-3">Källor:</h4>
              <div className="space-y-3">
                {qaResults.sources.map((source) => (
                  <div key={source.chunkId} className="bg-white p-3 rounded border">
                    <p className="font-semibold text-blue-600">
                      {source.title}
                    </p>
                    <p className="text-sm text-gray-600 mt-1">
                      {source.excerpt}
                    </p>
                    <div className="flex justify-between items-center mt-2">
                      <span className="text-xs text-gray-500">
                        Relevans: {(source.relevance * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 text-sm text-gray-600">
            Säkerhet: {(qaResults.confidence * 100).toFixed(0)}%
          </div>
        </div>
      )}
    </div>
  );
}
```

### Layout och routing (`App.tsx`)

```typescript
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { Home } from './pages/Home';
import { Browse } from './pages/Browse';
import { Search } from './pages/Search';
import { QA } from './pages/QA';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-50">
        <nav className="bg-white border-b">
          <div className="max-w-6xl mx-auto px-4 py-4 flex gap-6">
            <Link to="/" className="font-bold text-lg hover:text-blue-600">
              Confluence Mirror
            </Link>
            <Link to="/browse" className="hover:text-blue-600">
              Bläddra
            </Link>
            <Link to="/search" className="hover:text-blue-600">
              Sök
            </Link>
            <Link to="/qa" className="hover:text-blue-600">
              Frågor & Svar
            </Link>
          </div>
        </nav>

        <main className="max-w-6xl mx-auto px-4 py-8">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/search" element={<Search />} />
            <Route path="/qa" element={<QA />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
```

## Option 2: Next.js

För en mer komplett lösning med server-side rendering:

```bash
npx create-next-app@latest confluence-ui --typescript

cd confluence-ui
npm install axios zustand
```

Lägg till samma tjänster och komponenter, men struktur:

```
app/
├── page.tsx
├── browse/
│   └── page.tsx
├── search/
│   └── page.tsx
├── qa/
│   └── page.tsx
└── api/
    └── proxy/
        └── [...path].ts
```

## Option 3: Vue 3

```bash
npm create vue@latest confluence-ui

cd confluence-ui
npm install axios pinia vue-router
```

Samma koncept men med Vue composables.

## Styling

Använd Tailwind för snabb styling:

```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Exempel komponenter finns i `components/` foldern ovan.

## CORS Configuration

För local development, uppdatera `src/index.ts` i backend:

```typescript
import cors from 'cors';

app.use(cors({
  origin: 'http://localhost:5173', // Vite dev port
  credentials: true,
}));
```

## Production Build

```bash
npm run build
npm run preview
```

Deploy till:
- Vercel (Next.js rekommenderas)
- Netlify
- GitHub Pages
- Egen server med nginx

---

**Välj Option 1 (Vite + React) för snabbaste start, eller Option 2 (Next.js) för enterprise lösnng.**
