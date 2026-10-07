-- Phase 1 Validation Script for Supabase Schema
-- Tests structural integrity, constraints, and RLS policies
-- Uses proper exception handling to verify constraint violations

DO $$
DECLARE
    -- Test tracking variables
    v_passed INTEGER;
    v_failed INTEGER;
    v_total INTEGER;
    v_test_name TEXT;
    v_detail TEXT;
    
    -- Temporary test data
    v_test_google_sub TEXT := '__phase1_validation_google_sub_' || random()::TEXT;
    v_test_license_code TEXT := '__phase1_validation_license_code_' || random()::TEXT;
    v_test_license_id UUID;
    v_test_installation_id TEXT := '__phase1_validation_installation_' || random()::TEXT;
    v_test_token_id TEXT := '__phase1_validation_token_' || random()::TEXT;
    v_test_session_id TEXT := '__phase1_validation_session_' || random()::TEXT;
    v_test_drive_grant_id TEXT := '__phase1_validation_drive_' || random()::TEXT;
    
    -- Exception tracking
    v_exception_occurred BOOLEAN;
    v_exception_sqlstate TEXT;
    v_exception_message TEXT;
BEGIN
    -- Create temporary table for counters
    CREATE TEMP TABLE test_counters (passed INTEGER, failed INTEGER, total INTEGER);
    INSERT INTO test_counters VALUES (0,0,0);
    -- Helper procedure to record test results
    CREATE OR REPLACE PROCEDURE record_test(
        p_test_name TEXT,
        p_passed BOOLEAN,
        p_detail TEXT DEFAULT ''
    )
    LANGUAGE plpgsql
    AS $proc$
    BEGIN
        IF p_passed THEN
            UPDATE test_counters SET passed = passed + 1;
            RAISE NOTICE 'PASS: % - %', p_test_name, p_detail;
        ELSE
            UPDATE test_counters SET failed = failed + 1;
            RAISE NOTICE 'FAIL: % - %', p_test_name, p_detail;
        END IF;
        UPDATE test_counters SET total = total + 1;
    END;
    $proc$;

    -- Initialize counters
    v_passed := 0;
    v_failed := 0;
    v_total := 0;

    RAISE NOTICE 'Starting Phase 1 Schema Validation...';
    RAISE NOTICE '----------------------------------------';

    -- 1. STRUCTURAL VALIDATION: Table existence
    v_test_name := 'Table existence: google_accounts';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'google_accounts';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table google_accounts does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: licenses';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'licenses';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table licenses does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: license_tokens';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'license_tokens';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table license_tokens does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: license_installations';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'license_installations';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table license_installations does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: license_events';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'license_events';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table license_events does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: login_sessions';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'login_sessions';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table login_sessions does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Table existence: drive_grants';
    BEGIN
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'drive_grants';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Table drive_grants does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Table exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 2. COLUMN VALIDATION: google_accounts
    v_test_name := 'Column existence: google_accounts.google_sub';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'google_sub';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.google_sub does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Column existence: google_accounts.email';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'email';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.email does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Column existence: google_accounts.name';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'name';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.name does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Column existence: google_accounts.created_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'created_at';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.created_at does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Column existence: google_accounts.last_login_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'last_login_at';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.last_login_at does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 3. PRIMARY KEY VALIDATION
    v_test_name := 'Primary key: google_accounts (google_sub)';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' 
        AND constraint_type = 'PRIMARY KEY';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key constraint missing on google_accounts';
        END IF;
        
        -- Verify it's on google_sub column
        PERFORM 1 FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'google_accounts' 
            AND constraint_type = 'PRIMARY KEY'
        ) AND column_name = 'google_sub';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key on google_accounts is not on google_sub column';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Primary key exists on correct column');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Primary key: licenses (id)';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'licenses' 
        AND constraint_type = 'PRIMARY KEY';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key constraint missing on licenses';
        END IF;
        
        -- Verify it's on id column
        PERFORM 1 FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'licenses' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'licenses' 
            AND constraint_type = 'PRIMARY KEY'
        ) AND column_name = 'id';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key on licenses is not on id column';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Primary key exists on correct column');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Composite primary key: license_installations (license_id, installation_id)';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'license_installations' 
        AND constraint_type = 'PRIMARY KEY';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key constraint missing on license_installations';
        END IF;
        
        -- Verify it's composite on license_id and installation_id
        PERFORM COUNT(*) FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'license_installations' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'license_installations' 
            AND constraint_type = 'PRIMARY KEY'
        );
        IF NOT FOUND OR COUNT <> 2 THEN
            RAISE EXCEPTION 'Primary key on license_installations is not composite or missing columns';
        END IF;
        
        -- Check both columns are part of the PK
        PERFORM 1 FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'license_installations' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'license_installations' 
            AND constraint_type = 'PRIMARY KEY'
        ) AND column_name IN ('license_id', 'installation_id');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Primary key on license_installations missing required columns';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Composite primary key exists on correct columns');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 4. FOREIGN KEY VALIDATION
    v_test_name := 'Foreign key: licenses.owner_google_sub -> google_accounts.google_sub';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'licenses' 
        AND constraint_type = 'FOREIGN KEY';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Foreign key constraint missing on licenses.owner_google_sub';
        END IF;
        
        -- Verify it references google_accounts.google_sub
        PERFORM 1 FROM information_schema.key_column_usage kcu
        JOIN information_schema.referential_constraints rc ON kcu.constraint_name = rc.constraint_name
        JOIN information_schema.table_constraints tc ON rc.unique_constraint_name = tc.constraint_name
        WHERE kcu.table_schema = 'public' AND kcu.table_name = 'licenses' AND kcu.column_name = 'owner_google_sub'
        AND tc.table_name = 'google_accounts';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Foreign key on licenses.owner_google_sub does not reference google_accounts.google_sub';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key exists and references correct table/column');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 5. UNIQUE CONSTRAINT VALIDATION
    v_test_name := 'Unique constraint: licenses.code_lookup';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'licenses' 
        AND constraint_type = 'UNIQUE';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unique constraint missing on licenses.code_lookup';
        END IF;
        
        -- Verify it's on code_lookup column
        PERFORM 1 FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'licenses' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'licenses' 
            AND constraint_type = 'UNIQUE'
        ) AND column_name = 'code_lookup';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unique constraint on licenses is not on code_lookup column';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Unique constraint exists on correct column');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Unique constraint: google_accounts.google_sub';
    BEGIN
        PERFORM 1 FROM information_schema.table_constraints 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' 
        AND constraint_type = 'UNIQUE';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unique constraint missing on google_accounts.google_sub';
        END IF;
        
        -- Verify it's on google_sub column (note: this might be covered by PK, but checking explicitly)
        PERFORM 1 FROM information_schema.key_column_usage 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' 
        AND constraint_name = (
            SELECT constraint_name FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'google_accounts' 
            AND constraint_type = 'UNIQUE'
        ) AND column_name = 'google_sub';
        IF NOT FOUND THEN
            -- If no explicit unique constraint, check if PK serves this purpose (acceptable)
            PERFORM 1 FROM information_schema.table_constraints 
            WHERE table_schema = 'public' AND table_name = 'google_accounts' 
            AND constraint_type = 'PRIMARY KEY';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'No unique or primary key constraint on google_accounts.google_sub';
            END IF;
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Unique constraint exists (explicit or via PK)');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 6. CHECK CONSTRAINT VALIDATION
    v_test_name := 'Check constraint: licenses.status valid values';
    BEGIN
        PERFORM 1 FROM information_schema.check_constraints 
        WHERE constraint_schema = 'public' 
        AND constraint_name = 'licenses_status_check';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Check constraint licenses_status_check does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Check constraint exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 7. NOT NULL VALIDATION
    v_test_name := 'Not null: licenses.code_lookup';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'licenses' AND column_name = 'code_lookup' 
        AND is_nullable = 'NO';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column licenses.code_lookup is not NOT NULL';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column is NOT NULL');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Not null: licenses.owner_google_sub';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'licenses' AND column_name = 'owner_google_sub' 
        AND is_nullable = 'NO';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column licenses.owner_google_sub is not NOT NULL';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Column is NOT NULL');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 8. INDEX VALIDATION (comprehensive)
    -- Check that redundant indexes are absent
    v_test_name := 'Index absence: idx_licenses_code_lookup (redundant)';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'licenses' AND indexname = 'idx_licenses_code_lookup';
        IF FOUND THEN
            RAISE EXCEPTION 'Redundant index idx_licenses_code_lookup should not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Redundant index correctly absent');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index absence: idx_license_installations_license (redundant)';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'license_installations' AND indexname = 'idx_license_installations_license';
        IF FOUND THEN
            RAISE EXCEPTION 'Redundant index idx_license_installations_license should not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Redundant index correctly absent');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- Check that all required explicit indexes exist
    v_test_name := 'Index existence: idx_licenses_owner';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'licenses' AND indexname = 'idx_licenses_owner';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_licenses_owner does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_licenses_status_created';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'licenses' AND indexname = 'idx_licenses_status_created';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_licenses_status_created does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_license_tokens_license';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'license_tokens' AND indexname = 'idx_license_tokens_license';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_license_tokens_license does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_license_tokens_revoked';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'license_tokens' AND indexname = 'idx_license_tokens_revoked';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_license_tokens_revoked does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_license_events_license_time';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'license_events' AND indexname = 'idx_license_events_license_time';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_license_events_license_time does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_login_sessions_google_sub';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'login_sessions' AND indexname = 'idx_login_sessions_google_sub';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_login_sessions_google_sub does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Index existence: idx_login_sessions_expires';
    BEGIN
        PERFORM 1 FROM pg_indexes 
        WHERE schemaname = 'public' AND tablename = 'login_sessions' AND indexname = 'idx_login_sessions_expires';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Required index idx_login_sessions_expires does not exist';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Required index exists');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 9. TIMESTAMP / DEFAULT VALIDATION
    v_test_name := 'Default validation: google_accounts.created_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'created_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.created_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: google_accounts.last_login_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'google_accounts' AND column_name = 'last_login_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column google_accounts.last_login_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: licenses.created_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'licenses' AND column_name = 'created_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column licenses.created_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: license_tokens.created_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'license_tokens' AND column_name = 'created_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column license_tokens.created_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: license_installations.first_seen_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'license_installations' AND column_name = 'first_seen_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column license_installations.first_seen_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: license_installations.last_seen_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'license_installations' AND column_name = 'last_seen_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column license_installations.last_seen_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: license_events.occurred_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'license_events' AND column_name = 'occurred_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column license_events.occurred_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: login_sessions.created_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'login_sessions' AND column_name = 'created_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column login_sessions.created_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: drive_grants.granted_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'drive_grants' AND column_name = 'granted_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column drive_grants.granted_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'Default validation: drive_grants.updated_at';
    BEGIN
        PERFORM 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'drive_grants' AND column_name = 'updated_at'
        AND column_default IS NOT NULL AND column_default LIKE '%now()%';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Column drive_grants.updated_at missing now() default';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Default is now()');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 10. CONSTRAINT VIOLATION TESTS (qual proper exception handling)
    
    -- A. Valid license -> google_accounts FK
    v_test_name := 'Valid FK: license -> google_accounts';
    BEGIN
        -- Create test google account
        INSERT INTO google_accounts (google_sub, email, name) 
        VALUES (v_test_google_sub, 'test@example.com', 'Test User');
        
        -- Create valid license referencing it
        INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
        VALUES (gen_random_uuid(), v_test_google_sub, v_test_license_code, 'active')
        RETURNING id INTO v_test_license_id;
        
        -- Verify relationship exists
        PERFORM 1 FROM licenses l 
        JOIN google_accounts ga ON l.owner_google_sub = ga.google_sub
        WHERE l.id = v_test_license_id AND ga.google_sub = v_test_google_sub;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Valid license-google_accounts relationship not found';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Valid relationship created and verified');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- B. Invalid license -> google_accounts FK
    v_test_name := 'Invalid FK: license -> google_accounts (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license with nonexistent google_sub
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), 'nonexistent_sub_12345', 'invalid_code_123', 'active');
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- C. Invalid license_token -> license FK
    v_test_name := 'Invalid FK: license_token -> license (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license_token with nonexistent license_id
            INSERT INTO license_tokens (license_id, token_hash, token_type, expires_at) 
            VALUES (gen_random_uuid(), 'hash123', 'Bearer', NOW() + INTERVAL '1 hour');
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- D. Invalid installation -> license FK
    v_test_name := 'Invalid FK: license_installation -> license (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license_installation with nonexistent license_id
            INSERT INTO license_installations (license_id, installation_id) 
            VALUES (gen_random_uuid(), 'test_installation_123');
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- E. Invalid license_event -> license FK
    v_test_name := 'Invalid FK: license_event -> license (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license_event with nonexistent license_id
            INSERT INTO license_events (license_id, event_type, event_data) 
            VALUES (gen_random_uuid(), 'created', '{}'::jsonb);
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- F. Invalid login_session -> google_accounts FK
    v_test_name := 'Invalid FK: login_session -> google_accounts (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert login_session with nonexistent google_sub
            INSERT INTO login_sessions (google_sub, session_token, expires_at) 
            VALUES ('nonexistent_sub_67890', 'token123', NOW() + INTERVAL '1 day');
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- G. Invalid drive_grant -> google_accounts FK
    v_test_name := 'Invalid FK: drive_grant -> google_accounts (nonexistent parent)';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert drive_grant with nonexistent google_sub
            INSERT INTO drive_grants (google_sub, drive_folder_id, access_token) 
            VALUES ('nonexistent_sub_abcde', 'folder123', 'token123');
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Foreign key violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- H. Duplicate license code_lookup
    v_test_name := 'Unique violation: duplicate licenses.code_lookup';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create first license with test code
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub, v_test_license_code, 'active');
            
            -- Attempt to insert duplicate code_lookup
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub, v_test_license_code, 'active');
            EXCEPTION
                WHEN unique_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected unique violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Unique violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- I. Duplicate google_sub
    v_test_name := 'Unique violation: duplicate google_accounts.google_sub';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create first google account
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub, 'test1@example.com', 'Test User 1');
            
            -- Attempt to insert duplicate google_sub
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub, 'test2@example.com', 'Test User 2');
            EXCEPTION
                WHEN unique_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected unique violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Unique violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- J. Duplicate license_installations composite PK
    v_test_name := 'Unique violation: duplicate license_installations composite PK';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test license
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub, 'unique_code_for_install', 'active')
            RETURNING id INTO v_test_license_id;
            
            -- Create first installation
            INSERT INTO license_installations (license_id, installation_id) 
            VALUES (v_test_license_id, v_test_installation_id);
            
            -- Attempt to insert duplicate composite PK
            INSERT INTO license_installations (license_id, installation_id) 
            VALUES (v_test_license_id, v_test_installation_id);
            EXCEPTION
                WHEN unique_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected unique violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Unique violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- K. Invalid license status
    v_test_name := 'Check violation: invalid licenses.status';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license with invalid status
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub, 'invalid_status_code', 'invalid_status');
            EXCEPTION
                WHEN check_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected check violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Check violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- L. NOT NULL violation (at least one)
    v_test_name := 'Not null violation: licenses.code_lookup';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Attempt to insert license with NULL code_lookup
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub, NULL, 'active');
            EXCEPTION
                WHEN not_null_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected not null violation but insert succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'Not null violation properly raised');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- 11. ON DELETE TESTS
    
    -- RESTRICT for required relationships (should prevent deletion)
    v_test_name := 'ON DELETE RESTRICT: licenses -> google_accounts';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test data
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub || '_restrict', 'restrict@example.com', 'Restrict Test');
            
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub || '_restrict', 'restrict_code', 'active')
            RETURNING id INTO v_test_license_id;
            
            -- Attempt to delete referenced google account
            DELETE FROM google_accounts WHERE google_sub = v_test_google_sub || '_restrict';
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation on delete but delete succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE RESTRICT working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- RESTRICT: license_tokens.license_id -> licenses.id
    v_test_name := 'ON DELETE RESTRICT: license_tokens -> licenses';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test data: google_account -> license -> token
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub || '_token_r', 'token@example.com', 'Token Test');
            
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub || '_token_r', 'token_code', 'active')
            RETURNING id INTO v_test_license_id;
            
            INSERT INTO license_tokens (license_id, token_hash, token_type, expires_at) 
            VALUES (v_test_license_id, 'tokenhash123', 'Bearer', NOW() + INTERVAL '1 hour');
            
            -- Attempt to delete referenced license
            DELETE FROM licenses WHERE id = v_test_license_id;
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation on delete but delete succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE RESTRICT working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- RESTRICT: license_installations.license_id -> licenses.id
    v_test_name := 'ON DELETE RESTRICT: license_installations -> licenses';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test data: google_account -> license -> installation
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub || '_inst_r', 'inst@example.com', 'Installation Test');
            
            INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
            VALUES (gen_random_uuid(), v_test_google_sub || '_inst_r', 'inst_code', 'active')
            RETURNING id INTO v_test_license_id;
            
            INSERT INTO license_installations (license_id, installation_id) 
            VALUES (v_test_license_id, v_test_installation_id || '_inst');
            
            -- Attempt to delete referenced license
            DELETE FROM licenses WHERE id = v_test_license_id;
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation on delete but delete succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE RESTRICT working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- RESTRICT: login_sessions.google_sub -> google_accounts.google_sub
    v_test_name := 'ON DELETE RESTRICT: login_sessions -> google_accounts';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test data: google_account -> login_session
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub || '_sess_r', 'sess@example.com', 'Session Test');
            
            INSERT INTO login_sessions (google_sub, session_token, expires_at) 
            VALUES (v_test_google_sub || '_sess_r', 'sess_token123', NOW() + INTERVAL '1 day');
            
            -- Attempt to delete referenced google account
            DELETE FROM google_accounts WHERE google_sub = v_test_google_sub || '_sess_r';
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation on delete but delete succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE RESTRICT working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- RESTRICT: drive_grants.google_sub -> google_accounts.google_sub
    v_test_name := 'ON DELETE RESTRICT: drive_grants -> google_accounts';
    BEGIN
        v_exception_occurred := FALSE;
        BEGIN
            -- Create test data: google_account -> drive_grant
            INSERT INTO google_accounts (google_sub, email, name) 
            VALUES (v_test_google_sub || '_drive_r', 'drive@example.com', 'Drive Test');
            
            INSERT INTO drive_grants (google_sub, refresh_cipher, scopes, granted_at, updated_at) 
            VALUES (v_test_google_sub || '_drive_r', 'cipher123', 'scope1', now(), now());
            
            -- Attempt to delete referenced google account
            DELETE FROM google_accounts WHERE google_sub = v_test_google_sub || '_drive_r';
            EXCEPTION
                WHEN foreign_key_violation THEN
                    v_exception_occurred := TRUE;
                    GET STACKED DIAGNOSTICS v_exception_sqlstate = RETURNED_SQLSTATE, 
                                              v_exception_message = MESSAGE_TEXT;
        END;
        
        IF NOT v_exception_occurred THEN
            RAISE EXCEPTION 'Expected foreign key violation on delete but delete succeeded';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE RESTRICT working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- SET NULL for license_events.license_id
    v_test_name := 'ON DELETE SET NULL: license_events.license_id';
    BEGIN
        -- Create test license
        INSERT INTO licenses (id, owner_google_sub, code_lookup, status) 
        VALUES (gen_random_uuid(), v_test_google_sub, 'setnull_code', 'active')
        RETURNING id INTO v_test_license_id;
        
        -- Create license_event referencing it
        INSERT INTO license_events (license_id, event_type, event_data) 
        VALUES (v_test_license_id, 'test_event', '{}'::jsonb);
        
        -- Verify license_id is set before delete
        PERFORM 1 FROM license_events WHERE license_id = v_test_license_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'License event not found before delete test';
        END IF;
        
        -- Delete the license
        DELETE FROM licenses WHERE id = v_test_license_id;
        
        -- Verify license_id is now NULL in license_events
        PERFORM 1 FROM license_events WHERE license_id IS NULL AND event_type = 'test_event';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'License event license_id was not set to NULL after delete';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'ON DELETE SET NULL working properly');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- 12. CLEANUP TEST DATA
    v_test_name := 'Cleanup: Remove test data';
    BEGIN
        -- Delete in reverse order to avoid FK issues
        DELETE FROM license_events WHERE license_id = v_test_license_id;
        DELETE FROM license_installations WHERE license_id = v_test_license_id;
        DELETE FROM license_tokens WHERE license_id = v_test_license_id;
        DELETE FROM licenses WHERE owner_google_sub LIKE '__phase1_validation_%';
        DELETE FROM google_accounts WHERE google_sub LIKE '__phase1_validation_%';
        DELETE FROM login_sessions WHERE google_sub LIKE '__phase1_validation_%';
        DELETE FROM drive_grants WHERE google_sub LIKE '__phase1_validation_%';
        
        CALL record_test(v_test_name, TRUE, 'Test data cleaned up');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- 13. FINAL VERIFICATION: No test rows remaining
    v_test_name := 'Verification: No test rows remaining';
    BEGIN
        -- Check for any remaining test data
        PERFORM 1 FROM google_accounts WHERE google_sub LIKE '__phase1_validation_%';
        IF FOUND THEN
            RAISE EXCEPTION 'Test google_accounts rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM licenses WHERE owner_google_sub LIKE '__phase1_validation_%';
        IF FOUND THEN
            RAISE EXCEPTION 'Test licenses rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM license_tokens WHERE license_id IN (
            SELECT id FROM licenses WHERE owner_google_sub LIKE '__phase1_validation_%'
        );
        IF FOUND THEN
            RAISE EXCEPTION 'Test license_tokens rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM license_installations WHERE license_id IN (
            SELECT id FROM licenses WHERE owner_google_sub LIKE '__phase1_validation_%'
        );
        IF FOUND THEN
            RAISE EXCEPTION 'Test license_installations rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM license_events WHERE license_id IN (
            SELECT id FROM licenses WHERE owner_google_sub LIKE '__phase1_validation_%'
        );
        IF FOUND THEN
            RAISE EXCEPTION 'Test license_events rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM login_sessions WHERE google_sub LIKE '__phase1_validation_%';
        IF FOUND THEN
            RAISE EXCEPTION 'Test login_sessions rows remain after cleanup';
        END IF;
        
        PERFORM 1 FROM drive_grants WHERE google_sub LIKE '__phase1_validation_%';
        IF FOUND THEN
            RAISE EXCEPTION 'Test drive_grants rows remain after cleanup';
        END IF;
        
        CALL record_test(v_test_name, TRUE, 'No test rows remaining');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- 14. RLS VALIDATION
    -- Check RLS enabled on all seven tables
    v_test_name := 'RLS: Enabled on google_accounts';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'google_accounts' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on google_accounts';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on licenses';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'licenses' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on licenses';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on license_tokens';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'license_tokens' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on license_tokens';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on license_installations';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'license_installations' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on license_installations';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on license_events';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'license_events' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on license_events';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on login_sessions';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'login_sessions' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on login_sessions';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS: Enabled on drive_grants';
    BEGIN
        PERFORM 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'drive_grants' AND rowsecurity = true;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'RLS not enabled on drive_grants';
        END IF;
        CALL record_test(v_test_name, TRUE, 'RLS enabled');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- RLS Policies: deny all for anon and authenticated on each table
    -- We'll check each table for both anon and authenticated policies that restrict access
    -- Helper function to check policy exists and is restrictive (FIXED)
    CREATE OR REPLACE FUNCTION check_restrictive_policy(p_scheme TEXT, p_table TEXT, p_role TEXT)
RETURNS SETOF INTEGER
LANGUAGE plpgsql
AS $proc$
BEGIN
    RETURN QUERY
    SELECT 1
    FROM pg_policies
    WHERE schemaname = p_scheme
      AND tablename = p_table
      AND (roles IS NULL OR roles = '{}' OR p_role = ANY(roles))
      AND qual = 'false'
      AND with_check = 'false';
END;
$proc$;
    -- Now test each table for anon and authenticated
    -- We'll do a series of tests
    v_test_name := 'RLS Policy: anon has no access on google_accounts';
    BEGIN
        PERFORM check_restrictive_policy('public', 'google_accounts', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on google_accounts';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on google_accounts';
    BEGIN
        PERFORM check_restrictive_policy('public', 'google_accounts', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on google_accounts';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on licenses';
    BEGIN
        PERFORM check_restrictive_policy('public', 'licenses', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on licenses';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on licenses';
    BEGIN
        PERFORM check_restrictive_policy('public', 'licenses', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on licenses';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on license_tokens';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_tokens', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on license_tokens';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on license_tokens';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_tokens', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on license_tokens';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on license_installations';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_installations', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on license_installations';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on license_installations';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_installations', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on license_installations';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on license_events';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_events', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on license_events';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on license_events';
    BEGIN
        PERFORM check_restrictive_policy('public', 'license_events', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on license_events';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on login_sessions';
    BEGIN
        PERFORM check_restrictive_policy('public', 'login_sessions', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on login_sessions';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on login_sessions';
    BEGIN
        PERFORM check_restrictive_policy('public', 'login_sessions', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on login_sessions';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: anon has no access on drive_grants';
    BEGIN
        PERFORM check_restrictive_policy('public', 'drive_grants', 'anon');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for anon on drive_grants';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Anon access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    v_test_name := 'RLS Policy: authenticated has no access on drive_grants';
    BEGIN
        PERFORM check_restrictive_policy('public', 'drive_grants', 'authenticated');
        IF NOT FOUND THEN
            RAISE EXCEPTION 'No restrictive policy found for authenticated on drive_grants';
        END IF;
        CALL record_test(v_test_name, TRUE, 'Authenticated access properly restricted');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;

    -- 15. ABSENCE OF OPERATIONAL STORE TABLES
    v_test_name := 'Absence: No operational store tables';
    BEGIN
        -- Check that tables like products, orders, etc. don't exist (they shouldn't in Phase 1)
        PERFORM 1 FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('products', 'orders', 'order_items', 'inventory', 'stores');
        IF FOUND THEN
            RAISE EXCEPTION 'Operational store tables found that should not exist in Phase 1';
        END IF;
        CALL record_test(v_test_name, TRUE, 'No operational store tables present');
    EXCEPTION WHEN OTHERS THEN
        CALL record_test(v_test_name, FALSE, SQLERRM);
    END;
    
    -- Get final counts from the temporary table
    SELECT passed, failed, total INTO v_passed, v_failed, v_total FROM test_counters;
    -- Final Summary
    RAISE NOTICE '----------------------------------------';
    RAISE NOTICE 'PHASE 1 VALIDATION SUMMARY';
    RAISE NOTICE '----------------------------------------';
    RAISE NOTICE 'PASSED: %', v_passed;
    RAISE NOTICE 'FAILED: %', v_failed;
    RAISE NOTICE 'TOTAL: %', v_total;
    IF v_failed = 0 THEN
        RAISE NOTICE 'OVERALL RESULT: PASS';
    ELSE
        RAISE NOTICE 'OVERALL RESULT: FAIL';
    END IF;
    
END $$;
