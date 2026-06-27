-- Migration: add font_scale column to users table
ALTER TABLE users ADD COLUMN font_scale REAL DEFAULT 1.0;
