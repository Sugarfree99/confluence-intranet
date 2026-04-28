import dotenv from "dotenv";

dotenv.config();

export const config = {
  confluence: {
    baseUrl: process.env.CONFLUENCE_BASE_URL || "",
    username: process.env.CONFLUENCE_USERNAME || "",
    apiToken: process.env.CONFLUENCE_API_TOKEN || "",
    spaceKey: process.env.CONFLUENCE_SPACE_KEY || "NORDREST",
  },
  database: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    database: process.env.DB_NAME || "confluence_mirror",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
  },
  server: {
    port: parseInt(process.env.PORT || "3000"),
    env: process.env.NODE_ENV || "development",
  },
  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || "60"),
  },
};

export default config;
