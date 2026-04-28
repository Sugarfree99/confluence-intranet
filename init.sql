CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    confluence_id VARCHAR(255) UNIQUE NOT NULL,
    title VARCHAR(1000) NOT NULL,
    content TEXT,
    space_key VARCHAR(100),
    url VARCHAR(1000),
    raw_html TEXT,
    last_synced TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pages_confluence_id ON pages(confluence_id);
CREATE INDEX IF NOT EXISTS idx_pages_space_key ON pages(space_key);
CREATE INDEX IF NOT EXISTS idx_pages_last_synced ON pages(last_synced);

CREATE TABLE IF NOT EXISTS chunks (
    id SERIAL PRIMARY KEY,
    page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    confluence_id VARCHAR(255) NOT NULL,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    chunk_type VARCHAR(50),
    character_count INT,
    token_count INT,
    start_position INT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chunks_page_id ON chunks(page_id);
CREATE INDEX IF NOT EXISTS idx_chunks_confluence_id ON chunks(confluence_id);

CREATE TABLE IF NOT EXISTS embeddings (
    id SERIAL PRIMARY KEY,
    chunk_id INT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    embedding float8[],
    model VARCHAR(255) DEFAULT 'text-embedding-3-small',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_chunk_id ON embeddings(chunk_id);

CREATE TABLE IF NOT EXISTS page_relationships (
    id SERIAL PRIMARY KEY,
    source_page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target_page_id INT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    relationship_type VARCHAR(100),
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_page_rel_source ON page_relationships(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_rel_target ON page_relationships(target_page_id);

CREATE TABLE IF NOT EXISTS sync_logs (
    id SERIAL PRIMARY KEY,
    sync_type VARCHAR(50),
    status VARCHAR(50),
    items_processed INT,
    items_failed INT,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_created ON sync_logs(started_at);
