CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workflow_cycles (
    id BIGSERIAL PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    cycle_uuid UUID NOT NULL DEFAULT gen_random_uuid(),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'partial', 'failed', 'skipped')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    total_pages_targeted INTEGER NOT NULL DEFAULT 0 CHECK (total_pages_targeted >= 0),
    total_pages_posted INTEGER NOT NULL DEFAULT 0 CHECK (total_pages_posted >= 0),
    total_pages_failed INTEGER NOT NULL DEFAULT 0 CHECK (total_pages_failed >= 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE workflow_locks (
    lock_key TEXT PRIMARY KEY,
    owner_id UUID NOT NULL,
    workflow_name TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT workflow_locks_expiry_check CHECK (expires_at > acquired_at)
);

CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_name TEXT NOT NULL,
    page_niche TEXT NOT NULL,
    language TEXT NOT NULL CHECK (language IN ('th', 'en')),
    tone TEXT NOT NULL,
    page_id TEXT NOT NULL UNIQUE,
    page_access_token TEXT NOT NULL,
    drive_folder_id TEXT NOT NULL,
    drive_folder_name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    stagger_seconds INTEGER NOT NULL DEFAULT 45 CHECK (stagger_seconds >= 0),
    cooldown_hours INTEGER NOT NULL DEFAULT 72 CHECK (cooldown_hours >= 0),
    last_posted_at TIMESTAMPTZ NULL,
    platform_targets JSONB NOT NULL DEFAULT '{"facebook": true, "instagram": false, "x": false, "linkedin": false, "tiktok": false}'::jsonb,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE media_assets (
    id BIGSERIAL PRIMARY KEY,
    drive_file_id TEXT NOT NULL UNIQUE,
    drive_folder_id TEXT NOT NULL,
    folder_context TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_stem TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    source_url TEXT NOT NULL,
    checksum_sha256 TEXT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'cooldown', 'exhausted', 'disabled')),
    last_used_at TIMESTAMPTZ NULL,
    cooldown_until TIMESTAMPTZ NULL,
    usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    exhausted BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id BIGSERIAL PRIMARY KEY,
    workflow_cycle_id BIGINT NOT NULL REFERENCES workflow_cycles(id) ON DELETE CASCADE,
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
    media_asset_id BIGINT NULL REFERENCES media_assets(id) ON DELETE SET NULL,
    platform TEXT NOT NULL DEFAULT 'facebook' CHECK (platform IN ('facebook', 'instagram', 'x', 'linkedin', 'tiktok')),
    external_post_id TEXT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'success', 'failure', 'retrying', 'skipped')),
    caption_text TEXT NULL,
    request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_code TEXT NULL,
    error_message TEXT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    posted_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT posts_external_post_id_unique UNIQUE (platform, external_post_id)
);

CREATE TABLE page_media_history (
    id BIGSERIAL PRIMARY KEY,
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    media_asset_id BIGINT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    workflow_cycle_id BIGINT NOT NULL REFERENCES workflow_cycles(id) ON DELETE CASCADE,
    post_id BIGINT NULL REFERENCES posts(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_at TIMESTAMPTZ NULL,
    status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'posted', 'failed', 'released')),
    CONSTRAINT page_media_history_cycle_unique UNIQUE (workflow_cycle_id, media_asset_id),
    CONSTRAINT page_media_history_page_cycle_unique UNIQUE (workflow_cycle_id, page_id)
);

CREATE INDEX idx_pages_active_language ON pages (active, language);
CREATE INDEX idx_pages_last_posted_at ON pages (last_posted_at);
CREATE INDEX idx_media_assets_status_cooldown ON media_assets (status, exhausted, cooldown_until);
CREATE INDEX idx_media_assets_drive_folder_id ON media_assets (drive_folder_id);
CREATE INDEX idx_media_assets_last_used_at ON media_assets (last_used_at);
CREATE INDEX idx_posts_cycle_status ON posts (workflow_cycle_id, status);
CREATE INDEX idx_posts_page_created_at ON posts (page_id, created_at DESC);
CREATE INDEX idx_page_media_history_page_media_posted ON page_media_history (page_id, media_asset_id, posted_at DESC);
CREATE INDEX idx_workflow_cycles_workflow_started_at ON workflow_cycles (workflow_name, started_at DESC);
CREATE INDEX idx_workflow_locks_expires_at ON workflow_locks (expires_at);

INSERT INTO pages (
    id, page_name, page_niche, language, tone, page_id, page_access_token, drive_folder_id, drive_folder_name,
    active, stagger_seconds, cooldown_hours, last_posted_at, platform_targets, metadata
) VALUES
('11111111-1111-1111-1111-111111111111', 'Bangkok Street Bites', 'Thai street food', 'th', 'friendly playful', 'fb_page_10001', 'EAABsbCS1iHgBOZAfb_page_token_10001', 'drive_food_th', 'Street Food Thailand', TRUE, 30, 72, NOW() - INTERVAL '2 days', '{"facebook": true, "instagram": true, "x": false, "linkedin": false, "tiktok": false}'::jsonb, '{"country":"TH","audience":"food lovers"}'::jsonb),
('22222222-2222-2222-2222-222222222222', 'Urban Gadget Hub', 'consumer tech deals', 'en', 'sharp persuasive', 'fb_page_10002', 'EAABsbCS1iHgBOZAfb_page_token_10002', 'drive_gadgets_en', 'Gadget Hub EN', TRUE, 45, 96, NOW() - INTERVAL '3 days', '{"facebook": true, "instagram": false, "x": true, "linkedin": true, "tiktok": false}'::jsonb, '{"country":"US","audience":"tech shoppers"}'::jsonb),
('33333333-3333-3333-3333-333333333333', 'Healthy Home Living', 'wellness and home lifestyle', 'th', 'warm trustworthy', 'fb_page_10003', 'EAABsbCS1iHgBOZAfb_page_token_10003', 'drive_lifestyle_th', 'Healthy Lifestyle TH', TRUE, 60, 120, NOW() - INTERVAL '5 days', '{"facebook": true, "instagram": true, "x": false, "linkedin": false, "tiktok": true}'::jsonb, '{"country":"TH","audience":"family wellness"}'::jsonb);

INSERT INTO media_assets (
    drive_file_id, drive_folder_id, folder_context, file_name, file_stem, mime_type, source_url,
    checksum_sha256, status, last_used_at, cooldown_until, usage_count, exhausted, metadata
) VALUES
('gd_0001', 'drive_food_th', 'Street food / grilled skewers', 'moo-ping-night-market-01.jpg', 'moo-ping-night-market-01', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0001', 'sha256_0001', 'ready', NULL, NULL, 0, FALSE, '{"tags":["food","night-market"]}'::jsonb),
('gd_0002', 'drive_food_th', 'Street food / noodles', 'boat-noodles-bowl-02.jpg', 'boat-noodles-bowl-02', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0002', 'sha256_0002', 'ready', NULL, NULL, 0, FALSE, '{"tags":["food","noodles"]}'::jsonb),
('gd_0003', 'drive_food_th', 'Street food / dessert', 'mango-sticky-rice-03.jpg', 'mango-sticky-rice-03', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0003', 'sha256_0003', 'ready', NULL, NULL, 0, FALSE, '{"tags":["food","dessert"]}'::jsonb),
('gd_0004', 'drive_food_th', 'Street food / coffee', 'thai-iced-coffee-04.jpg', 'thai-iced-coffee-04', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0004', 'sha256_0004', 'ready', NULL, NULL, 0, FALSE, '{"tags":["drink","coffee"]}'::jsonb),
('gd_0005', 'drive_food_th', 'Street food / seafood', 'grilled-squid-05.jpg', 'grilled-squid-05', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0005', 'sha256_0005', 'ready', NULL, NULL, 0, FALSE, '{"tags":["seafood"]}'::jsonb),
('gd_0006', 'drive_food_th', 'Street food / breakfast', 'thai-roti-banana-06.jpg', 'thai-roti-banana-06', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0006', 'sha256_0006', 'ready', NULL, NULL, 0, FALSE, '{"tags":["breakfast","dessert"]}'::jsonb),
('gd_0007', 'drive_gadgets_en', 'Tech deals / headphones', 'wireless-headphones-sale-07.png', 'wireless-headphones-sale-07', 'image/png', 'https://drive.google.com/uc?id=gd_0007', 'sha256_0007', 'ready', NULL, NULL, 0, FALSE, '{"tags":["audio","sale"]}'::jsonb),
('gd_0008', 'drive_gadgets_en', 'Tech deals / smartwatch', 'smartwatch-fitness-track-08.png', 'smartwatch-fitness-track-08', 'image/png', 'https://drive.google.com/uc?id=gd_0008', 'sha256_0008', 'ready', NULL, NULL, 0, FALSE, '{"tags":["wearable"]}'::jsonb),
('gd_0009', 'drive_gadgets_en', 'Tech deals / laptop', 'ultrabook-work-anywhere-09.png', 'ultrabook-work-anywhere-09', 'image/png', 'https://drive.google.com/uc?id=gd_0009', 'sha256_0009', 'ready', NULL, NULL, 0, FALSE, '{"tags":["laptop","productivity"]}'::jsonb),
('gd_0010', 'drive_gadgets_en', 'Tech deals / phone', 'camera-phone-launch-10.png', 'camera-phone-launch-10', 'image/png', 'https://drive.google.com/uc?id=gd_0010', 'sha256_0010', 'ready', NULL, NULL, 0, FALSE, '{"tags":["phone","camera"]}'::jsonb),
('gd_0011', 'drive_gadgets_en', 'Tech deals / desk setup', 'rgb-desk-setup-11.png', 'rgb-desk-setup-11', 'image/png', 'https://drive.google.com/uc?id=gd_0011', 'sha256_0011', 'ready', NULL, NULL, 0, FALSE, '{"tags":["desk","gaming"]}'::jsonb),
('gd_0012', 'drive_gadgets_en', 'Tech deals / accessories', 'portable-ssd-speed-12.png', 'portable-ssd-speed-12', 'image/png', 'https://drive.google.com/uc?id=gd_0012', 'sha256_0012', 'ready', NULL, NULL, 0, FALSE, '{"tags":["storage","portable"]}'::jsonb),
('gd_0013', 'drive_lifestyle_th', 'Healthy living / smoothie', 'green-smoothie-morning-13.jpg', 'green-smoothie-morning-13', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0013', 'sha256_0013', 'ready', NULL, NULL, 0, FALSE, '{"tags":["wellness","drink"]}'::jsonb),
('gd_0014', 'drive_lifestyle_th', 'Healthy living / yoga', 'yoga-living-room-14.jpg', 'yoga-living-room-14', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0014', 'sha256_0014', 'ready', NULL, NULL, 0, FALSE, '{"tags":["fitness","home"]}'::jsonb),
('gd_0015', 'drive_lifestyle_th', 'Healthy living / clean kitchen', 'clean-kitchen-routine-15.jpg', 'clean-kitchen-routine-15', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0015', 'sha256_0015', 'ready', NULL, NULL, 0, FALSE, '{"tags":["home","routine"]}'::jsonb),
('gd_0016', 'drive_lifestyle_th', 'Healthy living / bedroom', 'sleep-hygiene-bedroom-16.jpg', 'sleep-hygiene-bedroom-16', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0016', 'sha256_0016', 'ready', NULL, NULL, 0, FALSE, '{"tags":["sleep","wellness"]}'::jsonb),
('gd_0017', 'drive_lifestyle_th', 'Healthy living / family meal', 'family-salad-table-17.jpg', 'family-salad-table-17', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0017', 'sha256_0017', 'ready', NULL, NULL, 0, FALSE, '{"tags":["family","nutrition"]}'::jsonb),
('gd_0018', 'drive_lifestyle_th', 'Healthy living / plants', 'indoor-plants-calm-home-18.jpg', 'indoor-plants-calm-home-18', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0018', 'sha256_0018', 'ready', NULL, NULL, 0, FALSE, '{"tags":["plants","home"]}'::jsonb),
('gd_0019', 'drive_shared', 'Generic lifestyle / inspiration', 'sunrise-motivation-19.jpg', 'sunrise-motivation-19', 'image/jpeg', 'https://drive.google.com/uc?id=gd_0019', 'sha256_0019', 'ready', NULL, NULL, 0, FALSE, '{"tags":["generic","motivation"]}'::jsonb),
('gd_0020', 'drive_shared', 'Generic promo / social post', 'weekend-special-banner-20.png', 'weekend-special-banner-20', 'image/png', 'https://drive.google.com/uc?id=gd_0020', 'sha256_0020', 'ready', NULL, NULL, 0, FALSE, '{"tags":["promo","generic"]}'::jsonb);
