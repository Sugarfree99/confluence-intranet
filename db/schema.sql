-- Create pages table
CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    confluence_id VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(1000) NOT NULL,
    content TEXT,
    space_key VARCHAR(100),
    url VARCHAR(1000),
    raw_html TEXT,
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    embedding float8[],
    embedding_updated_at TIMESTAMP
);

-- Make sure existing tables get the embedding columns too.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding float8[];
ALTER TABLE pages ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_pages_confluence_id ON pages(confluence_id);
CREATE INDEX IF NOT EXISTS idx_pages_space_key ON pages(space_key);
CREATE INDEX IF NOT EXISTS idx_pages_last_synced ON pages(last_synced);
CREATE INDEX IF NOT EXISTS idx_pages_title_tsvector ON pages USING GIN(to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_pages_content_tsvector ON pages USING GIN(to_tsvector('english', content));

-- Create search function
CREATE OR REPLACE FUNCTION search_pages(search_query TEXT)
RETURNS TABLE(id INT, confluence_id VARCHAR, title VARCHAR, content TEXT, rank REAL) AS $$
BEGIN
    RETURN QUERY
    SELECT pages.id, pages.confluence_id, pages.title, pages.content,
           ts_rank(to_tsvector('english', pages.content), to_tsquery('english', search_query)) AS rank
    FROM pages
    WHERE to_tsvector('english', pages.content) @@ to_tsquery('english', search_query)
       OR to_tsvector('english', pages.title) @@ to_tsquery('english', search_query)
    ORDER BY rank DESC;
END;
$$ LANGUAGE plpgsql;

-- Create chunks table (for AI processing and embeddings)
CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    confluence_id VARCHAR(255) NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    chunk_type VARCHAR(50), -- 'paragraph', 'heading', 'code', 'table', etc.
    character_count INT,
    token_count INT,
    start_position INT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_confluence_id ON chunks(confluence_id);
CREATE INDEX IF NOT EXISTS idx_chunks_content_tsvector ON chunks USING GIN(to_tsvector('english', content));

-- Create embeddings table (for vector search)
CREATE TABLE IF NOT EXISTS embeddings (
    id SERIAL PRIMARY KEY,
    chunk_id INT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedding float8[], -- Array of 1536 floats for OpenAI embeddings
    model VARCHAR(255) DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);

-- Create relationships table (for page interconnections)
CREATE TABLE IF NOT EXISTS page_relationships (
    id SERIAL PRIMARY KEY,
    source_page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100), -- 'references', 'linked', 'related', etc.
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_rel_source ON page_relationships(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_rel_target ON page_relationships(target_page_id);

-- Create sync logs for tracking
CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50), -- 'pages', 'chunks', 'embeddings'
    status VARCHAR(50), -- 'success', 'failed', 'processing'
    items_processed INT,
    items_failed INT,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(started_at);

-- Create attachments table (files attached to Confluence pages)
CREATE TABLE IF NOT EXISTS attachments (
    id SERIAL PRIMARY KEY,
    confluence_id VARCHAR(255) UNIQUE NOT NULL,
    page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    page_confluence_id VARCHAR(255) NOT NULL,
    title VARCHAR(1000) NOT NULL,
    file_name VARCHAR(1000),
    media_type VARCHAR(255),
    file_size BIGINT,
    download_url VARCHAR(2000),
    web_url VARCHAR(2000),
    version INT,
    file_data BYTEA,
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- For databases created before raw-bytes storage was added.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS file_data BYTEA;

CREATE INDEX IF NOT EXISTS idx_attachments_page_id ON attachments(page_id);
CREATE INDEX IF NOT EXISTS idx_attachments_page_confluence_id ON attachments(page_confluence_id);
CREATE INDEX IF NOT EXISTS idx_attachments_title ON attachments(title);

-- Enable pgvector extension if using PostgreSQL with pgvector
-- CREATE EXTENSION IF NOT EXISTS vector;
