/* Quay 1 — shared frontend config.
 * Loaded before app.js / admin/admin.js. Safe to commit (RLS gates writes).
 */
window.QUAY_CFG = Object.freeze({
  SUPABASE_URL: 'https://dqszbqiimbfvmmnpgpsb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxc3picWlpbWJmdm1tbnBncHNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NDk4OTQsImV4cCI6MjA5NjQyNTg5NH0.M9RQnJEidyIMZAwbELTSPakiSnvuWBdHTjD7nuOdCZY',
  // Synthetic email domain used internally for PIN-based auth.
  AUTH_EMAIL_DOMAIN: 'quay1.local',
});
