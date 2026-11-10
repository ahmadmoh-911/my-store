-- 001_validation.sql leaves two helpers behind after it runs its checks.
-- Nothing at runtime calls them, and Supabase's linter flags both
-- (function_search_path_mutable). Re-run 001_validation.sql if you need them.
DROP PROCEDURE IF EXISTS public.record_test(text, boolean, text);
DROP FUNCTION IF EXISTS public.check_restrictive_policy(text, text, text);
